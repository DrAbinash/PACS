#!/usr/bin/env bash
# The claims this repository makes about its own deployment, checked as commands
# rather than trusted as prose: the compose file interpolates, Orthanc is not
# anonymous, and no image-plane port is published to the host.
set -uo pipefail

cd "$(dirname "$0")/../.."
fail=0
warn=0

if command -v docker >/dev/null 2>&1; then
  if TR_RUNTIME=/tmp/tr-check TR_DB_NAME=x TR_DB_USER=x TR_DB_PASSWORD=x \
     ORTHANC_IMAGE_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000 TR_ORTHANC_USER=x TR_ORTHANC_PASSWORD=x TR_ORTHANC_BASIC_B64=x TR_SESSION_SECRET=x \
     TR_UPLOAD_SIGNING_SECRET=x TR_PUBLIC_URL=https://x docker compose config >/dev/null 2>&1; then
    echo "ok   compose.yaml interpolates"
  else
    echo "FAIL compose.yaml does not interpolate"
    fail=1
  fi
else
  echo "skip docker not present here — run this check on the NAS"
fi

# Measured on the registry: orthancteam/orthanc has no "1.13.0" tag, only CalVer
# tags and latest. A version string in this slot therefore cannot be pulled, and
# the failure appears on the NAS at first boot rather than on a laptop.
if grep -Eq '^ORTHANC_IMAGE_DIGEST=sha256:[0-9a-f]{64}$' .env.example; then
  echo "ok   .env.example pins the image plane by digest"
else
  echo "FAIL .env.example does not pin ORTHANC_IMAGE_DIGEST to a 64-hex sha256 digest"
  fail=1
fi

for pair in '"AuthenticationEnabled": true' '"RegistrationEnabled": false'; do
  if grep -q "$pair" infra/orthanc/orthanc.json; then
    echo "ok   orthanc.json has $pair"
  else
    echo "FAIL orthanc.json is missing $pair"
    fail=1
  fi
done

# Verified on 1.13.0: with authentication on and no declared user the image refuses
# to start, and the credential must arrive as ORTHANC_PASSWORD. A compose file that
# loses that line produces a container that never becomes healthy.
if grep -q 'ORTHANC_PASSWORD: ${TR_ORTHANC_PASSWORD}' compose.yaml; then
  echo "ok   compose passes the Orthanc credential"
else
  echo "FAIL compose.yaml no longer passes ORTHANC_PASSWORD to the image plane"
  fail=1
fi

if grep -Eq 'AccessControlAllowOrigin.*\*' infra/orthanc/orthanc.json; then
  echo "FAIL orthanc.json allows any CORS origin"
  fail=1
else
  echo "ok   no wildcard CORS origin"
fi

# The image plane stays on the docker network. Anything that publishes 8042 to the
# host re-opens the defect this project refused to inherit from care-pacs.
if grep -Eq '^\s*-\s*"?[0-9.]+:8042' compose.yaml; then
  echo "FAIL compose.yaml publishes Orthanc REST to the host"
  fail=1
else
  echo "ok   Orthanc REST is not host-published"
fi

# Measured on the pinned image: it ships no curl and no wget, and its /ping answers
# 404 even with a valid credential. A healthcheck built on either of those never
# turns green, so every service that depends_on orthanc waits forever — the failure
# looks like a hang, not like a bad line in the compose file.
if grep -qE 'test:.*\b(wget|curl)\b.*8042' compose.yaml; then
  echo "FAIL the orthanc healthcheck uses a downloader that image does not ship"
  fail=1
elif grep -qE '8042/system' compose.yaml; then
  echo "ok   orthanc healthcheck probes an endpoint that answers 200"
else
  echo "FAIL orthanc healthcheck no longer probes /system (see the measured note above)"
  fail=1
fi

# Two things this repository could not confirm by reading, and must confirm by
# booting. Both are recorded in docs/ARCHITECTURE.md "Known open items".
echo "verify-on-boot: DicomAet in orthanc.json was ignored by 1.13.0 (log said AET ORTHANC);"
echo "  and the PostgreSQL index plugin path is not loaded with this config mounted."
warn=1

# The site address must carry a hostname: a hostless `:8443` gives Caddy no name
# to issue the internal certificate for. The refusal was measured on this stack,
# 2026-10-12, while `auto_https off` was also present — the two causes were not
# isolated, and both are checked below.
if grep -q 'TR_TLS_HOSTNAME: ${TR_TLS_HOSTNAME:-localhost}' compose.yaml; then
  echo "ok   caddy receives TR_TLS_HOSTNAME for the internal certificate"
else
  echo "FAIL compose.yaml no longer passes TR_TLS_HOSTNAME to caddy"
  fail=1
fi

# `auto_https off` disables certificate management entirely, leaving `tls internal`
# nothing to provision — every handshake dies with an alert while the logs stay
# silent about why (measured on this stack, 2026-10-12). Only the redirects-only
# form is allowed here.
if grep -Eq '^\s*auto_https\s+off\s*$' infra/caddy/Caddyfile; then
  echo "FAIL Caddyfile sets auto_https off, which disables the internal certificate"
  fail=1
else
  echo "ok   auto_https keeps certificate management enabled"
fi

# The api code defaults to loopback, which is unreachable from another container:
# the healthcheck stays green while Caddy gets connection refused — the one
# failure mode a healthcheck cannot catch.
if grep -q 'TR_BIND_HOST: 0.0.0.0' compose.yaml; then
  echo "ok   api binds every interface inside the container"
else
  echo "FAIL compose.yaml no longer sets TR_BIND_HOST for the api"
  fail=1
fi

# A partial command override replaces the image CMD entirely; the node base
# image's entrypoint turns a bare `run` into `node run`, a crash loop that looks
# like a missing module (measured on this stack, 2026-10-12).
if grep -q 'command: \["node", "apps/worker/dist/main.js", "run"\]' compose.yaml; then
  echo "ok   worker command override carries the full node invocation"
else
  echo "FAIL worker command override is not the full node invocation"
  fail=1
fi

if [[ -f .env ]]; then
  host=$(sed -n 's/^TR_TLS_HOSTNAME=//p' .env | tr -d '"' | tr -d "'")
  pub=$(sed -n 's/^TR_PUBLIC_URL=//p' .env | tr -d '"' | tr -d "'")
  if [[ -n "$host" && -n "$pub" && "$pub" != "https://$host"* ]]; then
    echo "WARN TR_PUBLIC_URL does not start with https://$host — the session cookie origin and the notification links would disagree with the certificate name"
  else
    echo "ok   TR_PUBLIC_URL matches the certificate name"
  fi
fi

# A plain-http public origin is a development convenience, never a deployment.
if [[ -f .env ]] && grep -qE '^TR_PUBLIC_URL=http://' .env; then
  echo "WARN .env sets TR_PUBLIC_URL to http; session cookies lose the Secure flag"
fi

exit "$fail"
