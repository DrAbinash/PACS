#!/usr/bin/env bash
# Does the API survive losing its database?
#
# Every route in this service is a chain of awaits on postgres. Express 4 does not
# await a route handler, so before the `ah()` boundary in apps/api/src/handler.ts a
# rejected read was an unhandledRejection, and Node's default action for that is to
# terminate the process. The observable failure was not a 500: it was the API
# vanishing, the container restarting under it, and every reader on the panel seeing
# an outage that looked like a new one.
#
# This script measures the whole chain against a real database that is really taken
# away: it builds a throwaway schema, bootstraps an owner, starts the built API,
# stops the container under it, and asks three questions at that moment — did the
# request get answered, was the answer a JSON 500 with nothing leaked in it, and is
# the same process still serving seconds later. Then the database comes back and the
# last question is whether the pool recovered without anyone restarting anything.
#
# Nothing here touches a deployed stack. The database is created, used and removed by
# this script, on a port it picks for itself, with fixture credentials.
#
#   usage: bash scripts/validation/run-fault-injection.sh
#   needs: docker, a built workspace (pnpm build), and ports 5413 and 3101 free
set -euo pipefail

DB_CONTAINER=tr-fault-db
DB_HOST_PORT=5413
DB_NAME=telrad
DB_USER=telrad
DB_PASSWORD=fault-injection-db-fixture-not-a-real-credential
API_PORT=3101
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/telrad-fault.XXXXXX")"
INBOX="$WORKDIR/inbox"
# One fixture passphrase for one fixture owner account this script creates and
# deletes. Named so a reader and the secret scanner both know which it is.
FIXTURE_PASS=fault-injection-fixture-passphrase-not-real
mkdir -p "$INBOX"

passed=0
failed=0
ok() { echo "  ok   $*"; passed=$((passed + 1)); }
no() { echo "  FAIL $*"; failed=$((failed + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1 = $2"; else no "$1: expected [$3] got [$2]"; fi; }

cleanup() {
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" 2>/dev/null || true; fi
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

export TR_DB_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$DB_HOST_PORT/$DB_NAME"
export TR_ORTHANC_URL="http://127.0.0.1:8042"
export TR_ORTHANC_USER="orthanc"
export TR_ORTHANC_PASSWORD="fault-injection-orthanc-fixture-not-a-real-credential"
export TR_SESSION_SECRET="fault-injection-session-fixture-not-a-real-secret-0123456789"
export TR_UPLOAD_SIGNING_SECRET="fault-injection-signing-fixture-not-a-real-secret-0123"
export TR_PUBLIC_URL="http://127.0.0.1:$API_PORT"
export TR_INBOX_ROOT="$INBOX"
export PORT="$API_PORT"

echo "== fault injection: the database is taken away from a running API =="
echo "start      db=$DB_HOST_PORT api=$API_PORT work=$WORKDIR"

echo "-- database"
docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$DB_CONTAINER" -p "127.0.0.1:$DB_HOST_PORT:5432" \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null \
  || { echo "the throwaway database never became ready"; exit 1; }

echo "-- migrations"
(cd "$ROOT/packages/db" && pnpm exec tsx src/migrate.ts) | tail -1

echo "-- bootstrap"
(cd "$ROOT/apps/api" && pnpm exec tsx src/cli.ts bootstrap \
  --email fault-owner@telrad.test --name "Fault Owner" \
  --password "$FIXTURE_PASS" \
  --node-id node-fault --node-url http://127.0.0.1:8042 \
  --tenant-code faultco --tenant-name "Fault Injection Test Centre") | tail -2

echo "-- api"
(cd "$ROOT/apps/api" && exec node dist/server.js >"$WORKDIR/api.log" 2>&1) &
API_PID=$!
# `exec` above matters: without it $! is a subshell and the test would be reporting
# that a wrapper survived while the API underneath it had already died.
for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:$API_PORT/health/live" >/dev/null 2>&1; then break; fi
  sleep 1
done

login=$(curl -s -o "$WORKDIR/login.json" -w '%{http_code}' -c "$WORKDIR/cookies.txt" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"fault-owner@telrad.test\",\"password\":\"$FIXTURE_PASS\"}" \
  "http://127.0.0.1:$API_PORT/v1/auth/login")
check "login" "$login" "200"

studies() {
  curl -s -o "$WORKDIR/body.json" -w '%{http_code}' -b "$WORKDIR/cookies.txt" \
    "http://127.0.0.1:$API_PORT/v1/studies?state=orphan"
}
alive() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health/live"; }
running() { if kill -0 "$API_PID" 2>/dev/null; then echo yes; else echo no; fi; }

check "GET /v1/studies with a healthy database" "$(studies)" "200"

echo "-- the database disappears"
docker stop -t 2 "$DB_CONTAINER" >/dev/null

after="$(studies)"
body="$(cat "$WORKDIR/body.json" | tr -d '\n')"
check "GET /v1/studies while the database is gone" "$after" "500"
check "the 500 body is a code and nothing else" "$body" '{"ok":false,"error":"internal_error"}'
check "the process is still running" "$(running)" "yes"
check "GET /health/live still answers" "$(alive)" "200"

echo "-- and again, seconds later, from the same process"
check "a second request also answers 500" "$(studies)" "500"
check "still the same process" "$(running)" "yes"

echo "-- the database comes back"
docker start "$DB_CONTAINER" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 1
done
sleep 2
check "GET /v1/studies recovers without a restart" "$(studies)" "200"
check "the same process served the whole test" "$(running)" "yes"

echo "-- the guard path rejects too, not only the route body"
docker stop -t 2 "$DB_CONTAINER" >/dev/null
guard="$(curl -s -o "$WORKDIR/guard.json" -w '%{http_code}' \
  -H "cookie: telrad_session=obviously-not-a-real-token-value" \
  "http://127.0.0.1:$API_PORT/v1/auth/session")"
check "requireAuth with the database gone" "$guard" "500"
check "the guard path leaves the process alive" "$(running)" "yes"
docker start "$DB_CONTAINER" >/dev/null
sleep 3
check "session reads again once it returns" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$WORKDIR/cookies.txt" "http://127.0.0.1:$API_PORT/v1/auth/session")" "200"

echo "== checks: passed=$passed failed=$failed pid=$API_PID =="
[ "$failed" = "0" ] || exit 1
