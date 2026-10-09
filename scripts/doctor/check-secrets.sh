#!/usr/bin/env bash
# Refuses a deployment that still carries a placeholder or a known default secret.
# This exists because an earlier stack on this hardware shipped with an internal
# API key of "1234", and a system that connects external organizations to patient
# images cannot inherit that.
set -euo pipefail

cd "$(dirname "$0")/../.."
fail=0

if [[ -f .env ]]; then
  if grep -Eq '<generated|changeme|^\s*[A-Z_]+=\s*$' .env; then
    echo "FAIL .env still contains a placeholder or an empty value"
    grep -En '<generated|changeme|^\s*[A-Z_]+=\s*$' .env | sed 's/^/  /'
    fail=1
  else
    echo "ok   .env has no placeholder values"
  fi
else
  echo "FAIL .env does not exist; copy .env.example"
  fail=1
fi

# Tracked files must never contain a credential, whatever .env says.
if git ls-files -z 2>/dev/null | xargs -0 grep -InE '(TR_DB_PASSWORD|TR_SESSION_SECRET|TR_ORTHANC_PASSWORD)\s*[:=]\s*[^ ]' 2>/dev/null \
   | grep -vE '(\.env\.example|<generated)' ; then
  echo "FAIL a credential appears in tracked content above"
  fail=1
else
  echo "ok   no credentials in tracked files"
fi

# An assignment, not a mention: this repository documents the bad example, and a
# check that failed on prose would be switched off within a week.
if grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=migrations      -E '(API_KEY|PASSWORD|SECRET|PIN)[^=]*[=:]\s*"?1234"?\s*$' . 2>/dev/null; then
  echo "FAIL a credential above is a four-digit number"
  fail=1
else
  echo "ok   no 1234-valued credential in the tree"
fi

exit "$fail"
