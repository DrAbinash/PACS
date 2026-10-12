#!/bin/sh
# A backup nobody has restored is a hope, not a backup. This drill takes the
# newest artifact pair written by backup.sh, restores them into THROWAWAY
# containers with --network none (the drill can neither reach the live stack
# nor be reached by it), re-opens the restored Orthanc index, and counts every
# database table and every image level against the manifest frozen at backup
# time — not against live counts, so clinic traffic since the backup cannot
# fake a pass. The live stack is only ever read. The drill deletes its own
# containers and extracted data on exit, pass or fail.
#
#   sh scripts/backup/restore-drill.sh
#
# The DRILL PASSED line means: the dump restores cleanly, the counts match the
# manifest, and Orthanc opened the restored store. It does not mean a viewer
# rendered a study — that acceptance belongs to the console, not to this drill.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null || pwd)"
cd "$ROOT"
BACKUPS="$ROOT/backups"
WORK="$ROOT/.runtime/drill"
START=$(date +%s)

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
[ -f .env ] || { echo ".env not found"; exit 1; }
set -a; . ./.env; set +a
ORTHANC_IMAGE_DIGEST=$(printf '%s' "${ORTHANC_IMAGE_DIGEST:-}" | tr -d '\r')
TR_ORTHANC_PASSWORD=$(printf '%s' "${TR_ORTHANC_PASSWORD:-}" | tr -d '\r')
: "${ORTHANC_IMAGE_DIGEST:?ORTHANC_IMAGE_DIGEST missing from .env}"
: "${TR_ORTHANC_PASSWORD:?TR_ORTHANC_PASSWORD missing from .env}"

DUMP=$(ls -t "$BACKUPS"/*-telrad-db.dump 2>/dev/null | head -1 || true)
[ -n "$DUMP" ] || { echo "no backups/*-telrad-db.dump — run scripts/backup/backup.sh first"; exit 1; }
STEM=$(basename "$DUMP" -telrad-db.dump)
TARF="$BACKUPS/$STEM-orthanc.tar.gz"
MAN="$BACKUPS/$STEM-manifest.txt"
[ -f "$TARF" ] || { echo "missing $TARF"; exit 1; }
[ -f "$MAN" ] || { echo "missing $MAN"; exit 1; }
ORTH_JSON="$ROOT/infra/orthanc/orthanc.json"

# git-bash: docker.exe wants C:/ style mount paths.
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

FAILS=0
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

# Manifest lookups: the sections are written by backup.sh, indented two spaces.
man_db()   { sed -n '/^tables:/,/^orthanc:/p' "$MAN" | awk -v t="$1" '$1==t{print $2}'; }
man_orth() { sed -n '/^orthanc:/,$p' "$MAN" | awk -v t="$1" '$1==t{print $2}'; }

db_counts() {
  # The app schema is "telrad" (plus "drizzle" for the migrations journal), NOT
  # "public" — measured against the live tr-db, where a public-only filter
  # silently counts zero tables.
  gen_sql='SELECT string_agg(format($f$SELECT %L, count(*)::bigint FROM %I.%I$f$, table_schema||$q$.$q$||table_name, table_schema, table_name), $f$ UNION ALL $f$ ORDER BY 1) FROM information_schema.tables WHERE table_schema NOT IN ($$pg_catalog$$, $$information_schema$$) AND table_type=$$BASE TABLE$$'
  sql=$(docker exec -e Q="$gen_sql" "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$Q"')
  [ -n "$sql" ] || { echo "no base tables found in $1" >&2; return 1; }
  docker exec -e Q="$sql" "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$Q"'
}

orth_counts() {
  for r in patients studies series instances; do
    n=$(docker exec "$1" python3 -c "
import os, base64, urllib.request, json
req = urllib.request.Request('http://127.0.0.1:8042/$r', headers={'Authorization': 'Basic ' + base64.b64encode(('orthanc:' + os.environ['ORTHANC_PASSWORD']).encode()).decode()})
print(len(json.load(urllib.request.urlopen(req, timeout=10))))")
    echo "$r $n"
  done
}

teardown() {
  docker rm -f tr-drill-db tr-drill-orthanc >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap teardown EXIT
mkdir -p "$WORK"
docker rm -f tr-drill-db tr-drill-orthanc >/dev/null 2>&1 || true

echo "== drill on $(basename "$DUMP")"

# --- phase 1: the database dump, restored into a sealed throwaway postgres ---
T0=$(date +%s)
docker run -d --name tr-drill-db --network none \
  -e POSTGRES_USER=drill -e POSTGRES_DB=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$(win "$DUMP")":/tmp/dump.dump:ro \
  postgres:16-alpine >/dev/null
ready=""
for i in $(seq 1 60); do
  if docker exec tr-drill-db pg_isready -U drill -d drill >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { echo "FAIL: drill postgres never became ready"; exit 1; }
# --no-owner --no-privileges: the dump carries GRANTs for roles that exist only
# on the live stack; the drill verifies data, not ACLs. MSYS_NO_PATHCONV: git-bash
# would rewrite /tmp/dump.dump into a Windows path before docker.exe sees it.
MSYS_NO_PATHCONV=1 docker exec tr-drill-db pg_restore -U drill -d drill --no-owner --no-privileges /tmp/dump.dump \
  || { echo "FAIL: pg_restore returned errors — the dump is not restorable"; exit 1; }
T1=$(date +%s)
echo "db restored in $((T1 - T0))s"

T2=$(date +%s)
drill_tables="$WORK/drill-tables.txt"
db_counts tr-drill-db > "$drill_tables"
matched=0
while IFS='|' read -r t n; do
  [ -n "$t" ] || continue
  m=$(man_db "$t")
  if [ -z "$m" ]; then
    fail "table $t is not in the manifest"
  elif [ "$n" != "$m" ]; then
    fail "table $t: manifest $m, restored $n"
  else
    matched=$((matched + 1))
  fi
done < "$drill_tables"
man_tables=$(sed -n '/^tables:/,/^orthanc:/p' "$MAN" | grep -c '^  ')
if [ "$matched" -ne "$man_tables" ]; then
  fail "matched $matched of $man_tables manifest tables — the restore is missing rows"
fi
echo "db verified: $matched/$man_tables tables match the manifest"
T3=$(date +%s)

# --- phase 2: the Orthanc store, re-opened from the tarball ---
rm -rf "$WORK/orthanc"
mkdir -p "$WORK/orthanc"
# --force-local: git-bash GNU tar reads C:/... as a remote host:path spec.
tar --force-local -xzf "$TARF" -C "$WORK/orthanc"
docker run -d --name tr-drill-orthanc --network none \
  -e ORTHANC_PASSWORD="$TR_ORTHANC_PASSWORD" \
  -v "$(win "$WORK")/orthanc":/var/lib/orthanc/db \
  -v "$(win "$ORTH_JSON")":/etc/orthanc/orthanc.json:ro \
  "orthancteam/orthanc@${ORTHANC_IMAGE_DIGEST}" >/dev/null
open=""
for i in $(seq 1 60); do
  if docker exec tr-drill-orthanc python3 -c "
import os, base64, urllib.request
req = urllib.request.Request('http://127.0.0.1:8042/system', headers={'Authorization': 'Basic ' + base64.b64encode(('orthanc:' + os.environ['ORTHANC_PASSWORD']).encode()).decode()})
raise SystemExit(0 if urllib.request.urlopen(req, timeout=5).status == 200 else 1)" >/dev/null 2>&1; then open=1; break; fi
  sleep 2
done
[ -n "$open" ] || { echo "FAIL: orthanc restore FAILED to open (torn backup?)"; exit 1; }
T4=$(date +%s)
echo "orthanc opened its restored index in $((T4 - T3))s"

drill_orth="$WORK/drill-orthanc.txt"
orth_counts tr-drill-orthanc > "$drill_orth"
while read -r r n; do
  [ -n "$r" ] || continue
  m=$(man_orth "$r")
  if [ -z "$m" ]; then
    fail "orthanc $r is not in the manifest"
  elif [ "$n" != "$m" ]; then
    fail "orthanc $r: manifest $m, restored $n"
  fi
done < "$drill_orth"
echo "orthanc verified: patients/studies/series/instances vs manifest"

END=$(date +%s)
echo ""
echo "RTO: $((END - START))s (db restore $((T1 - T0))s, db verify $((T2 - T1))s, orthanc open $((T4 - T3))s, orthanc verify $((END - T4))s)"
if [ "$FAILS" -eq 0 ]; then
  echo "DRILL PASSED — RTO $((END - START))s"
else
  echo "DRILL FAILED ($FAILS mismatches) — these artifacts must not be trusted until the drill is green"
  exit 1
fi
