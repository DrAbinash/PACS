#!/bin/sh
# Backup of the two stateful planes, written for the day it is needed rather
# than configured into a scheduler: the Postgres dump is taken ONLINE with
# pg_dump -Fc (transactionally consistent, the api never stops), the Orthanc
# store is tarred over its bind mount. The Orthanc side is NOT transactional —
# the SQLite index and the DICOM files are read at slightly different moments —
# which is exactly why restore-drill.sh exists and must be run against every
# artifact set before anybody trusts it.
#
#   sh scripts/backup/backup.sh
#
# Writes backups/<stamp>-telrad-db.dump, <stamp>-orthanc.tar.gz and a manifest
# of counts frozen at backup time; the drill verifies its restore against that
# manifest, not against live counts, so ongoing clinic traffic cannot fake a
# pass or a failure. backups/ carries PHI and is gitignored — copies of it
# belong off the machine, never in git.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null || pwd)"
cd "$ROOT"
BACKUPS="$ROOT/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
START=$(date +%s)

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx tr-db      || { echo "tr-db is not running"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx tr-orthanc || { echo "tr-orthanc is not running"; exit 1; }
[ -f .env ] || { echo ".env not found (TR_RUNTIME is read from it)"; exit 1; }
set -a; . ./.env; set +a
TR_RUNTIME=$(printf '%s' "${TR_RUNTIME:-}" | tr -d '\r')
[ -n "$TR_RUNTIME" ] || { echo "TR_RUNTIME missing from .env"; exit 1; }
[ -d "${TR_RUNTIME}/orthanc" ] || { echo "orthanc store ${TR_RUNTIME}/orthanc not found"; exit 1; }

mkdir -p "$BACKUPS"
DUMP="$BACKUPS/$STAMP-telrad-db.dump"
TARF="$BACKUPS/$STAMP-orthanc.tar.gz"
MAN="$BACKUPS/$STAMP-manifest.txt"

# One psql round-trip per side: a single UNION ALL count query built over every
# base table from information_schema. The query is passed through an env var so
# the container's own POSTGRES_USER/POSTGRES_DB stay in play and the host never
# handles a credential; dollar-quoting keeps the SQL shell-safe.
db_counts() {
  # The app schema is "telrad" (plus "drizzle" for the migrations journal), NOT
  # "public" — measured against the live tr-db, where a public-only filter
  # silently counts zero tables.
  gen_sql='SELECT string_agg(format($f$SELECT %L, count(*)::bigint FROM %I.%I$f$, table_schema||$q$.$q$||table_name, table_schema, table_name), $f$ UNION ALL $f$ ORDER BY 1) FROM information_schema.tables WHERE table_schema NOT IN ($$pg_catalog$$, $$information_schema$$) AND table_type=$$BASE TABLE$$'
  sql=$(docker exec -e Q="$gen_sql" "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$Q"')
  [ -n "$sql" ] || { echo "no base tables found in $1" >&2; return 1; }
  docker exec -e Q="$sql" "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$Q"'
}

# Same authenticated-shape counts the compose healthcheck uses: python3 is in
# the image, curl is not, and the password is read from the container's env so
# it is never printed or written to the manifest.
orth_counts() {
  for r in patients studies series instances; do
    n=$(docker exec "$1" python3 -c "
import os, base64, urllib.request, json
req = urllib.request.Request('http://127.0.0.1:8042/$r', headers={'Authorization': 'Basic ' + base64.b64encode(('orthanc:' + os.environ['ORTHANC_PASSWORD']).encode()).decode()})
print(len(json.load(urllib.request.urlopen(req, timeout=10))))")
    echo "$r $n"
  done
}

T1=$(date +%s)
docker exec tr-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP"
T2=$(date +%s)

# MSYS_NO_PATHCONV: git-bash rewrites bare /out/... arguments into Windows paths
# before docker.exe sees them (measured: tar got "C:/Program Files/Git/out/...").
MSYS_NO_PATHCONV=1 docker run --rm -v "${TR_RUNTIME}/orthanc":/src:ro -v "$BACKUPS":/out alpine \
  tar -czf "/out/$(basename "$TARF")" -C /src .
T3=$(date +%s)

{
  echo "stamp: $STAMP"
  echo "db.dump bytes: $(wc -c < "$DUMP")"
  echo "orthanc.tar.gz bytes: $(wc -c < "$TARF")"
  echo "pg_dump seconds: $((T2 - T1))"
  echo "orthanc tar seconds: $((T3 - T2))"
  echo "note: counts below are taken just after the artifacts are written; rows added by"
  echo "note: live traffic in those seconds are inside the dump but not in these counts."
  echo "tables:"
  db_counts tr-db | tr '|' ' ' | awk '{print "  " $0}'
  echo "orthanc:"
  orth_counts tr-orthanc | awk '{print "  " $0}'
} > "$MAN"

echo "backup: $(basename "$DUMP") ($(wc -c < "$DUMP") bytes, $((T2 - T1))s)"
echo "backup: $(basename "$TARF") ($(wc -c < "$TARF") bytes, $((T3 - T2))s)"
echo "manifest: $(basename "$MAN")"
echo "total: $(( $(date +%s) - START ))s — now prove it: sh scripts/backup/restore-drill.sh"
