#!/usr/bin/env bash
# Refuses a deployment that still carries a placeholder or a known default secret.
# This exists because an earlier stack on this hardware shipped with an internal
# API key of "1234", and a system that connects external organizations to patient
# images cannot inherit that.
set -euo pipefail

cd "$(dirname "$0")/../.."
fail=0

# Run before .env exists (a fresh clone) and after it exists (the boot gate), so an
# absent file is a skip with a instruction, not a failure that trains the operator to
# ignore this script. Nothing boots on a missing secret anyway: loadEnv throws.
if [[ -f .env ]]; then
  if grep -Eq '<generated|changeme|^\s*[A-Z_]+=\s*$' .env; then
    echo "FAIL .env still contains a placeholder or an empty value"
    grep -En '<generated|changeme|^\s*[A-Z_]+=\s*$' .env | sed 's/^/  /'
    fail=1
  else
    echo "ok   .env has no placeholder values"
  fi
else
  echo "skip no .env in this checkout; run this again after writing it"
fi

# Tracked files must never contain a credential, whatever .env says. Only a literal
# counts: ${VAR} interpolation, process.env reads and short fixture values are how a
# repository *passes* secrets around legally, and flagging them would put this check
# on the ignored list within a week. The cost is that a literal labelled "fixture"
# slips through, which is why the value below is deliberately named.
CRED='(TR_ORTHANC_PASSWORD|TR_SESSION_SECRET|TR_UPLOAD_SIGNING_SECRET|API_KEY|API_TOKEN)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9./_+:-]{12,}'
hits=$(git ls-files -z | xargs -0 grep -InE "$CRED" 2>/dev/null \
  | grep -vE '(\$\{?[A-Za-z_]|process\.env|env\.)' \
  | grep -vEi '(not-a-real|fixture|placeholder|changeme|<generated|example|sha256:)' || true)
if [[ -n "$hits" ]]; then
  echo "$hits"
  echo "FAIL a credential literal appears in tracked content above"
  fail=1
else
  echo "ok   no credential literals in tracked files"
fi

# A connection string carries its password inside it, so it is checked by shape
# rather than by variable name. Loopback hosts are exempt: a bind-on-CI password for
# a throwaway Postgres on 127.0.0.1 is a fixture, and a real one always names a host
# that is not this machine.
conn=$(git ls-files -z | xargs -0 grep -InE '[a-z][a-z0-9+.-]*://[A-Za-z0-9._-]+:[^@[:space:]"'"'"']{8,}@[^[:space:]"'"'"' ]' 2>/dev/null \
  | grep -vE '@(127\.0\.0\.1|localhost|\[::1\])' || true)
if [[ -n "$conn" ]]; then
  echo "$conn"
  echo "FAIL a connection string above carries a password for a non-loopback host"
  fail=1
else
  echo "ok   no routable connection string with an embedded password"
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
