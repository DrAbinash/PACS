# First deploy

The order matters: each step has an answer you can read before going on. Do not
run the whole file at once, and do not continue past a step that did not print
what it claims.

Requirements: a Docker host with Container Manager or Compose v2, 8 GB free RAM
for this stack alone, `${TR_RUNTIME}` on a Btrfs volume so snapshots exist, and
an NTP-synced clock — a future-dated signature is refused by design, so a drifting
clock stops reporting rather than corrupting it.

## 1. Obtain the code and check it before it touches a network

```bash
git clone <your-private-remote> telrad && cd telrad
pnpm install
pnpm check          # build + typecheck + tests + both doctors
```

`pnpm check` must be green before any container starts. It is the only step here
that needs no infrastructure. It runs `check-secrets.sh` too, which on a fresh
checkout can only test the repository itself — the `.env` half of that check
becomes real at step 2.

## 2. Write the env file

```bash
cp .env.example .env
```

Replace every `<generated: ...>`. For each one, run the command in its comment and
paste the result. `ORTHANC_IMAGE_DIGEST` is a digest, not a version: the registry
publishes `orthancteam/orthanc` under CalVer tags and `latest`, and there is no
`1.13.0` tag, so putting a version string there fails the pull. Confirm any digest
you swap in before booting it on the NAS:

```bash
docker manifest inspect orthancteam/orthanc@${ORTHANC_IMAGE_DIGEST} >/dev/null && echo pullable
```

```bash
bash scripts/doctor/check-secrets.sh   # must pass before the first boot
bash scripts/doctor/check-config.sh
```

`check-config.sh` ends by naming three Orthanc settings that must be verified
against the running version. That is not a todo, it is a warning the deployment
carries forward — see docs/ARCHITECTURE.md "Known open items".

## 3. Start the image plane

```bash
mkdir -p "$TR_RUNTIME"/{postgres,orthanc,caddy}
docker compose --profile nas up -d db orthanc
docker compose logs --tail=60 orthanc      # read every line
```

Three things must be true in that log, and each has been seen to fail:

- `Orthanc version: 1.13.0` (or whatever you pinned).
- `DICOM server listening with AET <your DicomAet>`. **On 1.13.0 the observed line
  read `AET ORTHANC` while the config asked for `TELRAD`**, which means that setting
  name is not being honoured. This does not block tenant routing — provenance comes
  from the *sending* AE title, `metadata/RemoteAET` — but it must be corrected before
  you describe an AE title to a center as identity.
- No `Unknown setting` warnings.

Orthanc's REST port must not be reachable from the host:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8042/ping   # expect 000 / connection refused
```

## 4. Confirm authentication is real

The image refuses to start with authentication enabled and no credential, so the
password arrives as `ORTHANC_PASSWORD` (compose maps it from `TR_ORTHANC_PASSWORD`)
and the username is `orthanc`:

```bash
docker compose exec orthanc curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8042/studies            # expect 401
docker compose exec orthanc curl -s -u "orthanc:$(printf %s "$TR_ORTHANC_PASSWORD")" -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8042/studies   # expect 200
```

A `200` on the first line means the anonymous image plane is still running, and
nothing external may connect until it is not.

## 5. Migrate and bootstrap

```bash
pnpm --filter @telrad/db db:migrate     # migrations/ is committed; CI regenerates and diffs it
docker compose --profile nas up -d api worker caddy
curl -sk https://127.0.0.1:8443/health/ready
```

`/health/ready` must return `{"ok":true,"components":{"db":true,"orthanc":true}}`.
Then create the first operator, tenant and storage node:

```bash
docker compose exec api node apps/api/dist/cli.js bootstrap \
  --email you@domain --name "Ops" --password '<long passphrase>' \
  --tenant-code demo --tenant-name "Demo Clinic" \
  --node-id node-nas-01 --node-url http://tr-orthanc:8042 --node-aet TELRAD
```

Bootstrap refuses a password under 14 characters and refuses to overwrite an
existing address. It writes the first row of the audit chain, so
`pnpm verify-audit` should report one row and `broken=0`.

**Then provision the readers, because nothing routes without them.** Coverage is a
claim, not a default: an account with no `--subs`/`--mods` list exists and is never
offered a case, and `*` is the only way to say a reader covers everything. `--tenant
<id>` binds a reader to one center; omitting it makes them a platform reader who can be
routed work from any center. Quote a name that contains a space — the CLI now refuses a
stray argument rather than silently creating an account called `Dr`:

```bash
docker compose exec api node apps/api/dist/cli.js add-reader \
  --email radiologist@domain --name "Dr Full Name" --password '<long passphrase>' \
  --council WBMC --reg-no WB-12345 --states WB --grade senior \
  --subs ct-head,mr-spine --mods CT,MR --max-queue 4
```

A reader only reaches the panel by signing in to the console and leaving the tab open:
the page sends a heartbeat every twenty seconds, and the colour goes red about ninety
seconds after the tab dies. Nobody is "on panel" because an account exists.

## 6. Register the site and prove ingest with your own scanner

The AE title you register is the one Orthanc reports as having **sent** the study
(`metadata/RemoteAET`), not the one your scanner claims inside the file:

```sql
insert into telrad.sub_specialties (code, name, default_priority, default_sla_minutes)
  values ('ct-head','CT head','urgent',120) on conflict do nothing;
insert into telrad.tenant_sites (tenant_id, name, ae_title) values (1, 'Demo CT', 'CT_SCANNER_1');
```

Then read the value a real study actually carried, rather than assuming it. This
image has no `curl` and no `wget`, so the read is done with the `python3` that is in
it:

```bash
docker compose exec orthanc python3 -c "
import os,base64,urllib.request
b=base64.b64encode(b'orthanc:'+os.environ['ORTHANC_PASSWORD'].encode()).decode()
print(urllib.request.urlopen(urllib.request.Request(
  'http://127.0.0.1:8042/instances/<pk>/metadata/RemoteAET',
  headers={'Authorization':'Basic '+b})).read().decode())"
```

Watch the counts, not the UI:

```bash
docker compose logs --since=2m worker
```

Expected within a couple of polls: `seen=1 ... created=1` and one `studies` row.
If `unresolved_site=1`, that is the RemoteAET above not matching any
`tenant_sites.ae_title`.

If you have no scanner wired yet, `scripts/validation/send-test-study.py` sends one
invented study over C-STORE and prints the four contract facts the worker depends
on. It was used to verify every claim in this section:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/scripts/validation:/v" -e TEST_ORTHANC_BASIC="orthanc:$TR_ORTHANC_PASSWORD" \
  -e TEST_ORTHANC_REST="http://tr-orthanc:8042" -e TEST_ORTHANC_HOST="tr-orthanc" \
  --network telrad_default python:3.11-slim sh -c "pip -q install pydicom pynetdicom && python /v/send-test-study.py"
```

## 7. Prove the upload channel, which is the one a center without a PACS uses

The C-STORE path above gives the worker a sending AE title to trust. An uploaded file
gives it nothing — Orthanc records no `RemoteAET` for a REST push — so attribution
here comes from a batch label the worker writes itself. That difference is the whole
mechanism, and it has to be run rather than read.

```bash
# Real Part-10 files, because Orthanc refuses anything that is not a dataset.
docker run --rm -v "$PWD/scripts/validation:/v" -e OUT_DIR=/v/out \
  -e ACCESSION=ACC-TEST-0001 -e PATIENT_ID=P-TEST-0001 -e PATIENT_NAME="Ramesh^Kumar" \
  python:3.11-slim sh -c "pip -q install pydicom && python /v/make-study-files.py"

python scripts/validation/run-p1-flow.py --api http://127.0.0.1:3001 \
  --email <bootstrap email> --password '<bootstrap passphrase>' \
  --dir scripts/validation/out --files img001.dcm,img002.dcm,img003.dcm \
  --accession ACC-TEST-0001
pnpm --filter @telrad/worker once      # TR_INBOX_ROOT must be the same directory the api writes into
```

`run-p1-flow.py` exits non-zero on any unexpected status, and it drives every upload
step with a site token on a client that has **no cookie jar**. That is deliberate: an
earlier version of the script shared the console's session, and behind it a
router-level session guard was refusing every real agent with 401.

What must be true afterwards:

- the worker logs `inbox batch=<id> pushed=3 rejected=0`, and no file row says
  `rejected` while its bytes are in Orthanc;
- `select status, error_code from telrad.upload_files` shows `pushed` with a null
  error — `label_failed` means the study is archived but unattributable, and will
  appear in the orphan queue as `site_unresolved`;
- the poll logs `unresolved_site=0` and the study row is `linked`, `match_method =
  accession`, with one `sla_clocks` row whose `deadline_at` is the study's
  `received_at` plus the sub-specialty window. A clock that opens on a later poll than
  the insert is normal — Orthanc calls a study unstable for about two minutes after
  its last instance lands.

Read the label back from the node to see the evidence the worker saw (again, `python3`
because the image has no `curl`):

```bash
docker compose exec orthanc python3 -c "
import os,base64,urllib.request,json
b=base64.b64encode(b'orthanc:'+os.environ['ORTHANC_PASSWORD'].encode()).decode()
print(json.load(urllib.request.urlopen(urllib.request.Request(
  'http://127.0.0.1:8042/instances/<pk>/labels',
  headers={'Authorization':'Basic '+b})))"
```

## 8. Run the console

The board is a static build, and Caddy serves it from `apps/web/dist` on the same
origin as the api — which is not a style choice. The session cookie is `HttpOnly` and
`SameSite=Strict`, so a second origin would mean either weakening that or storing a
token where any browser extension can read it.

```bash
pnpm --filter @telrad/web build          # writes apps/web/dist
docker compose --profile nas up -d caddy # serves it at https://<nas>:8443
```

Build it before starting Caddy. An empty `apps/web/dist` mounts fine and answers 404
for every page, which looks like a broken deployment rather than a missing build step.

For working on it locally, `pnpm --filter @telrad/web dev` serves the page and proxies
`/v1` to the api on `127.0.0.1:3101`, so the cookie stays first-party there too.

What has to be true on the board:

- a reader who signs in and leaves the page open shows **green**; close the tab and
  they must turn **red** within about ninety seconds without anyone touching anything;
- a reader who presses Pause stays **amber** even while their tab keeps heartbeating —
  if a refresh can turn somebody available again, the board is not telling the truth;
- a reader whose open cases equal their `max_queue_size` shows **amber "At
  capacity"**, which is a different fact from "gone" and is coloured differently;
- with nobody green, the board says so in a banner rather than showing an empty table.

The routing that reads that board runs in the worker, on the same poll interval. What
has to be true of it:

- a case is offered only to a reader who is **green and covers it**. To check: leave one
  green reader, one amber and one red on the board, send a study in, and confirm only the
  green one gets an entry under "Your cases" — the amber and red readers must show
  nothing;
- an offer nobody accepts lapses after five minutes and goes to somebody else, and the
  same reader is never asked twice for the same case;
- when nobody qualifies, `GET /v1/dispatch/unassigned` says which reader came closest and
  what they were missing (`not_routable`, `no_subspecialty_cover`, `queue_full`,
  `already_offered`). "Unassigned" is never a mystery;
- a study that is still arriving is **not** dispatched. Because Orthanc flips a study to
  stable without announcing it, the worker re-asks; if a study sits in the queue with
  `study_not_complete` for more than a few minutes, that re-check is what to look at
  first.

## 9. Prove the negative cases before trusting the pipeline

```bash
pnpm --filter @telrad/worker test   # unknown AE title → orphan, never a tenant's queue
pnpm --filter @telrad/shared test   # contradictory name/dob/modality → never auto-linked
pnpm --filter @telrad/api test      # refuses to boot on a placeholder secret
```

Then re-run the ingest poll a second time and confirm `studies` did not grow: the
cursor is the only thing standing between a restart and a duplicated worklist.

## 10. Backup before any real study

Three copies, and the third one off the premises: nightly `pg_dump` of the telrad
schema, a Btrfs snapshot task on `${TR_RUNTIME}/orthanc`, and a restic copy to a
destination the NAS cannot remount read-write. `scripts/doctor/check-secrets.sh`
runs against the repo, not your data — the data copies need their own schedule,
and a restore you have actually performed and timed. Until that rehearsal exists,
this deployment holds test data only.

## What is not here yet

The console's first screen is here — the on-panel board that colours readers green,
amber and red, and the heartbeat that keeps them that way. The worklist, the viewer,
assignment and escalation, report authoring, billing and HL7 are not. The upload
*endpoints* exist and are proven; the *agent* that a center installs on its modality
PC to call them does not, so today that channel only works for a browser upload or a
script. README at the root lists the phase plan; docs/ARCHITECTURE.md states what
exists, including what the panel does not yet do: **nothing consumes the green answer
until the dispatcher is built.**
