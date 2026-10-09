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

What has to be true when a clock starts running out. `scripts/validation/run-dispatch-flow.py`
and `run-escalation-flow.py` drive both halves over HTTP; the escalation one moves clocks by
**shortening the deadline**, never by backdating `received_at`, because a tighter contract is
the real cause and `received_at` is a fact about the scanner:

- a case whose only eligible reader is already **at capacity** is offered to them anyway once
  its clock passes the `widen_pool` stage, and the worker says so out loud:
  `escalate … actions=widen_pool:1` followed by `dispatch widened=1`;
- a paused reader, a stale tab, or a reader whose profile does not cover the study is
  **never** reached by that stage. Test it with a study nobody covers: it must stay `blocked`
  with `poolWidened: true` at every stage, and the reason shown must be one widening cannot
  fix;
- stages catch up. A case that crossed two thresholds while the worker was down must write
  both `sla.escalated` rows in one pass, and `sla.breached` exactly once however many passes
  follow — count them, do not assume: `select detail->>'accession', count(*) from
  telrad.audit_log where action = 'sla.breached' group by 1;`
- the operator's late board (`GET /v1/escalations`, the "Waiting" card) must agree with the
  sweep. A clock at stage 0 with time left must **not** appear on it; a case nobody holds
  appears with `holder: null` and the count of such cases;
- a manual assign is a person, not the router. `POST /v1/assignments` refuses without a
  reason, and when the target does not list the sub-specialty it succeeds *and* says so
  (`warning: "… does not list sub-specialty mr-spine or modality MR"`) with the same list in
  the audit row.

What has to be true of the viewer. `scripts/validation/run-view-flow.py` drives it over HTTP
and checks the pixels themselves; the points worth re-checking by hand on a real node:

- opening is **not** the same permission as reading the worklist. `GET /v1/view/:studyId`
  answers `not_your_case` to a signed-in reader who does not hold the case, and a study
  belonging to another centre answers **404 rather than 403**, so an id cannot be probed
  for existence;
- a second check happens per instance: an instance that exists on the node but is not in
  that study's tree is refused. Both halves have to pass, because the first one is about a
  person and the second is about a path;
- **the node cannot window, and this is not a belief.** Ask the same frame twice with
  different `/preview?window-center=` values: they come back byte-identical. That is why the
  api ships `int16` numbers and the browser does the level and width, and why the descriptor
  says `windowing: "client"`. If a future node starts honouring those parameters, this whole
  path should be re-measured before it is trusted;
- the numbers must be the numbers. A window change alters the picture and must never alter
  the values; `run-view-flow.py` re-derives each frame from the fixture's arithmetic, so a
  silent truncation to 8 bits or a row-order mistake fails loudly;
- a frame response carries `Cache-Control: no-store`. Pixels of a patient's study must not
  sit in a shared browser cache;
- if a study is `not_at_node` or the node rejects the credential, the viewer says so in a
  sentence. A reader staring at a black rectangle cannot tell "this node does not have it"
  from "this node is down", and those are different calls for different people.

Do **not** point OHIF at this deployment yet. `infra/orthanc/orthanc.json` contains a
`DicomWeb` block with `Enable: true`, but `curl -s -u …/dicom-web/` answers 404 on the pinned
image — the config is inert because the plugin is not loaded. Load it, re-measure, then revisit.

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

Built and proven on test data: the on-panel board and its heartbeat, the dispatcher that
offers a case only to a green reader who covers it, the reader's own worklist with accept
and decline, the escalation stages that widen the pool and stamp a breach, the operator's
late board, manual assign with its reason and its reported coverage mismatch, and a viewer
that shows a reader the case they hold — grayscale, window and level, series strip, slice
scroll — with the pixels verified against what the node actually stores.

Not built: a **diagnostic** viewer. What exists has no hanging protocols, no MPR, no
measurement or annotation tools, no cine, and shows one series at a time; it is enough to
look at a study and not enough to sign one. Also missing: report authoring and the
two-signature flow, delivery back to the center, billing and payouts, and any pager or SMS —
`alert_ops` and `notify_center` are recorded, not sent.
The upload *endpoints* exist and are proven; the *agent* a center installs on its modality
PC to call them does not, so today that channel only works for a browser upload or a
script. README at the root lists the phase plan; docs/ARCHITECTURE.md states what exists,
including the open items it names: **a declined case is never asked again**, **a widened
offer has no ceiling**, the viewer ships text-shaped pixels and their byte cost, and frames
are not individually audited.
