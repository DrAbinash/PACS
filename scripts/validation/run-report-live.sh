#!/usr/bin/env bash
# Drive the report flow from an empty machine to a verified audit chain, in one command.
#
# run-report-flow.py checks the HTTP behaviour; this script is the part it cannot do itself:
# bring up a seeded stack, feed the worker, wait for the image node to call the study stable,
# put one reader on panel so the dispatcher has somebody to ask, and run the phases in the
# order the lifecycle actually happens. Without it the flow is a script and six manual steps
# in somebody's head, and "proven live" would mean "proven once, by the person who remembered
# the order".
#
#   bash scripts/validation/run-report-live.sh              # full run, teardown at the end
#   bash scripts/validation/run-report-live.sh --keep       # leave the stack up for poking
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
STACK="$ROOT/scripts/validation/run-live-stack.sh"
KEEP="${1:-}"

say() { echo "── $*"; }

say "stack"
bash "$STACK" up

# shellcheck disable=SC1091
source "$ROOT/.runtime/live-stack/env.sh"

if [ ! -d "$ROOT/scripts/validation/out/rep1" ]; then
  say "fixtures"
  # Real Part-10 files: the image node refuses anything that is not a parsed dataset, and
  # the accession in the file is what the study is linked by later.
  MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT/scripts/validation:/v" \
    -e OUT_DIR=/v/out/rep1 -e ACCESSION=ACC-REP-1 -e PATIENT_ID=P-REP-1 \
    -e PATIENT_NAME="Kavita^Rao" -e MODALITY=CT -e BODY_PART=HEAD -e INSTANCE_COUNT=3 \
    python:3.11-slim sh -c "pip -q install pydicom && python /v/make-study-files.py" | tail -2
fi

say "phase prepare"
python "$ROOT/scripts/validation/run-report-flow.py" --phase prepare | tail -3

say "ingest"
(pnpm --filter @telrad/worker once 2>&1 | grep -E "inbox|ingest") || true

say "waiting for the study to be called stable, then linking and opening the clock"
for _ in $(seq 1 8); do
  sleep 45
  out=$(pnpm --filter @telrad/worker once 2>&1 | grep -E "settle") || true
  echo "  $out"
  case "$out" in *clocks_opened=1*) break ;; esac
done

# Presence is a heartbeat, not a login: a reader who has signed in but whose tab has been
# open for twenty minutes without one is red, and the sweep will not offer them anything.
say "one reader on panel"
curl -s -c /tmp/telrad-green.jar -H 'content-type: application/json' \
  -d '{"email":"dr-green@test.local","password":"testonly-passphrase-42"}' \
  "$TR_PUBLIC_URL/v1/auth/login" >/dev/null
curl -s -b /tmp/telrad-green.jar -H 'content-type: application/json' -d '{}' \
  "$TR_PUBLIC_URL/v1/presence/heartbeat" | head -c 120
echo

say "dispatch"
pnpm --filter @telrad/worker dispatch-once 2>&1 | grep -E "dispatch" || true

say "phase accept"
python "$ROOT/scripts/validation/run-report-flow.py" --phase accept | tail -3

say "phase check"
python "$ROOT/scripts/validation/run-report-flow.py" --phase check

say "phase critical"
python "$ROOT/scripts/validation/run-report-flow.py" --phase critical

say "phase notify"
python "$ROOT/scripts/validation/run-report-flow.py" --phase notify

say "phase late-clock-after-sign"
python "$ROOT/scripts/validation/run-report-flow.py" --phase late-clock-after-sign

say "audit chain"
# `pnpm --filter @telrad/api verify-audit` is not a script and pnpm says so on stdout while
# exiting 0, which is how a verification step goes missing from a green run. The root script
# is the one that exists, and the answer is asserted rather than printed.
out=$(pnpm verify-audit 2>&1 | tail -1)
echo "  $out"
case "$out" in
  *"broken=0"*) say "audit chain verified" ;;
  *) echo "the audit chain did not verify: $out" >&2; exit 1 ;;
esac

if [ "$KEEP" = "--keep" ]; then
  say "left up. tear it down with: bash $STACK down"
else
  bash "$STACK" down
fi
