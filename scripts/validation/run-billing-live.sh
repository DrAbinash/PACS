#!/usr/bin/env bash
# Drive the billing flow from an empty machine to a verified invoice, in one command.
#
# run-billing-flow.py checks the HTTP behaviour; this script is the part it cannot do itself:
# bring up a seeded stack, deliver five studies with known tariffs, and run the phases in the
# order the money actually moves. Without it the flow is a script and four manual steps in
# somebody's head, and "proven live" would mean "proven once, by the person who remembered
# the order".
#
#   bash scripts/validation/run-billing-live.sh              # full run, teardown at the end
#   bash scripts/validation/run-billing-live.sh --keep       # leave the stack up for poking
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

say "phase seed"
python "$ROOT/scripts/validation/run-billing-flow.py" --phase seed

say "phase deliver"
python "$ROOT/scripts/validation/run-billing-flow.py" --phase deliver

say "phase preview"
python "$ROOT/scripts/validation/run-billing-flow.py" --phase preview

say "phase invoice"
python "$ROOT/scripts/validation/run-billing-flow.py" --phase invoice

say "phase access"
python "$ROOT/scripts/validation/run-billing-flow.py" --phase access

if [ "$KEEP" = "--keep" ]; then
  say "left up. tear it down with: bash $STACK down"
else
  bash "$STACK" down
fi

say "billing flow verified"
