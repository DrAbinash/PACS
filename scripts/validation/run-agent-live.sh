#!/usr/bin/env bash
# Bring up a stack, hand it a folder of real exported studies, and let the agent do the sending.
#
# The upload channel has had endpoints and a worker since P1, and every proof of it so far drove
# those endpoints from a validation script that behaved perfectly. That is not the thing a center
# installs. This runs the agent binary the way the site would run it — a watch folder, a token
# file, cron or a console — and then asks the archive what arrived.
#
#   bash scripts/validation/run-agent-live.sh              # full run, teardown at the end
#   bash scripts/validation/run-agent-live.sh --keep       # leave it up for poking
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
STACK="$ROOT/scripts/validation/run-live-stack.sh"
FLOW="$ROOT/scripts/validation/run-agent-flow.py"
WATCH="$ROOT/.runtime/agent-watch"
KEEP="${1:-}"

say() { echo "── $*"; }
phase() { say "phase $1"; python "$FLOW" --phase "$1"; }

say "stack"
bash "$STACK" up

# shellcheck disable=SC1091
source "$ROOT/.runtime/live-stack/env.sh"

say "watch folder"
# Start from nothing every run: the cursor is the point of several of these assertions, so a
# leftover cursor would make them all pass for the wrong reason.
rm -rf "$WATCH"
mkdir -p "$WATCH/ACC-AGT-1" "$WATCH/RAVI KUMAR CT 20261010"

say "fixtures"
# Real Part-10 files — the image node refuses anything that is not a parsed dataset. Two studies,
# one folder named like an accession and one named like a patient, because that is the spread a
# real export folder has, and the second one must not be allowed to guess a hint.
MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT":/repo \
  -e OUT_DIR=/repo/.runtime/agent-watch/ACC-AGT-1 -e ACCESSION=ACC-AGT-1 \
  -e PATIENT_ID=P-AGT-1 -e PATIENT_NAME="Kavita^Agent" -e MODALITY=CT -e BODY_PART=HEAD \
  -e INSTANCE_COUNT=3 python:3.11-slim sh -c "pip -q install pydicom && python /repo/scripts/validation/make-study-files.py" | tail -1
MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT":/repo \
  -e OUT_DIR="/repo/.runtime/agent-watch/RAVI KUMAR CT 20261010" -e ACCESSION=ACC-AGT-2 \
  -e PATIENT_ID=P-AGT-2 -e PATIENT_NAME="Ravi^Kumar" -e MODALITY=CT -e BODY_PART=HEAD \
  -e INSTANCE_COUNT=2 python:3.11-slim sh -c "pip -q install pydicom && python /repo/scripts/validation/make-study-files.py" | tail -1
# The thing every export folder has and nobody modelled: a note somebody left beside the images.
printf 'CT head, 3 slices. Called Dr Rao about the first one.\n' > "$WATCH/ACC-AGT-1/README.txt"
find "$WATCH" -type f | sed 's/.*agent-watch\///' | sort

phase prepare
phase refuse-http
phase settle-gate
phase send
phase resume
phase two-scan
phase dead-api
phase ingest

say "audit chain"
pnpm verify-audit 2>&1 | tail -1

if [ "$KEEP" = "--keep" ]; then
  say "left up. tear it down with: bash $STACK down"
  say "watch folder kept at $WATCH"
else
  bash "$STACK" down
  rm -rf "$WATCH" "$ROOT/.runtime/agent-token.txt"
fi
