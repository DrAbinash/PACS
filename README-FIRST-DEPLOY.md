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

Leave `TR_SMTP_URL` and `TR_SMTP_FROM` empty until there is a relay to point at: the queue then
accumulates and `notify-once` reports `skipped` rather than destroying the record of which clinics
were never told. When you do fill them, fill all three together — `TR_SMTP_URL` without
`TR_PUBLIC_URL` produces a notice whose only actionable line is a link nobody can follow, and the
sweep refuses it rather than sending it.

`TR_TLS_HOSTNAME` is the one non-secret you must still choose deliberately: it is the name
centers type into their browser, and Caddy issues its internal certificate for exactly that
name — nothing else will complete a handshake. Set it to the DNS name that resolves to this
host and set `TR_PUBLIC_URL` to `https://$TR_TLS_HOSTNAME:$TR_HTTPS_PORT`; the doctor checks
the pair agrees. A bare IP cannot work (an IP URL sends no SNI, so Caddy has no name to
certify), and `localhost` is correct only for a single-machine trial.

```bash
bash scripts/doctor/check-secrets.sh   # must pass before the first boot
bash scripts/doctor/check-config.sh
```

`check-config.sh` ends by naming three Orthanc settings that must be verified
against the running version. That is not a todo, it is a warning the deployment
carries forward — see docs/ARCHITECTURE.md "Known open items".

## 3. Start the image plane

```bash
mkdir -p "$TR_RUNTIME"/{postgres,orthanc,inbox} "$TR_RUNTIME"/caddy/{config,data}
docker compose --profile nas up -d db orthanc
docker compose logs --tail=60 orthanc      # read every line
```

`inbox` is the spool the api writes uploaded batches into and the worker pushes
from; both containers run as uid 1000 (`node`). Synology's ACLs can display a
directory as `drwxrwxrwx` while the kernel — what the container sees — reports
`755`, and the api then answers every batch open with a 500
(`EACCES ... mkdir '/app/inbox/...'`). `chmod 777 "$TR_RUNTIME/inbox"` and probe
from inside the container before trusting it:
`docker compose exec api sh -c 'touch /app/inbox/.probe && rm /app/inbox/.probe'`.

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
and the username is `orthanc`. This image ships neither `curl` nor `wget`, so the
probe is the `python3` that is in it (the same fact the orthanc healthcheck
encodes):

```bash
docker compose exec orthanc python3 -c "
import urllib.request,urllib.error
try: print(urllib.request.urlopen('http://127.0.0.1:8042/studies',timeout=5).status)
except urllib.error.HTTPError as e: print(e.code)"                                     # expect 401
docker compose exec orthanc python3 -c "
import os,base64,urllib.request,urllib.error
h={'Authorization':'Basic '+base64.b64encode(('orthanc:'+os.environ['ORTHANC_PASSWORD']).encode()).decode()}
try: print(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8042/studies',headers=h),timeout=5).status)
except urllib.error.HTTPError as e: print(e.code)"                                     # expect 200
```

A `200` on the first line means the anonymous image plane is still running, and
nothing external may connect until it is not.

## 5. Migrate and bootstrap

```bash
docker compose --profile nas run --rm api node apps/api/dist/cli.js migrate
docker compose --profile nas up -d api caddy
# Probe with the name the certificate was issued for, not localhost: with any
# TR_TLS_HOSTNAME other than localhost, a loopback URL sends an SNI Caddy has no
# certificate for and the handshake dies with `tlsv1 alert internal error`.
# --resolve pins that name to loopback, which .local does not resolve from a shell.
curl -sk --resolve "$TR_TLS_HOSTNAME:8443:127.0.0.1" \
  "https://$TR_TLS_HOSTNAME:8443/health/ready"
```

The migration runs inside a one-off api container and nowhere else. The database
publishes no port by design, so a host-side `pnpm --filter @telrad/db db:migrate`
cannot connect from the NAS, and a Container Manager host has no node or pnpm
to try it with — while the api image already carries `packages/db/migrations`
(the Dockerfile copies `packages/`). The one-off runs first because the api
server refuses to boot against an unmigrated schema, and its crash loop would
hold caddy's `depends_on` down with it; the migrate must finish before `up`.
The worker is deliberately not started yet either: its first polls would error
against a half-migrated database.

The curl address is `https://localhost:8443` because TR_TLS_HOSTNAME defaults to
`localhost` and Caddy issues its internal certificate for exactly that name —
a bare IP cannot complete the handshake (an IP URL sends no SNI). Set
`TR_TLS_HOSTNAME` to the real name and browse that instead.

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
`docker compose exec api node apps/api/dist/cli.js verify-audit` should report one
row and `broken=0`.

```bash
docker compose --profile nas up -d worker
```

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
on. It was used to verify every claim in this section. The compose network to join
is the one the running stack actually got — measure it with
`docker network ls | grep telrad`; compose v2.20.1 names it after the project
alone (`telrad`), while newer releases append `_default`:

```bash
docker run --rm -v "$PWD/scripts/validation:/v" -e TEST_ORTHANC_BASIC="orthanc:$TR_ORTHANC_PASSWORD" \
  -e TEST_ORTHANC_REST="http://tr-orthanc:8042" -e TEST_ORTHANC_HOST="tr-orthanc" \
  --network telrad python:3.11-slim sh -c "pip -q install pydicom pynetdicom && python /v/send-test-study.py"
```

(The Orthanc password is sourced from `.env`, never typed: `set -a && . ./.env && set +a`
before the run, and it reaches only the container's environment.)

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

python scripts/validation/run-p1-flow.py --api https://AbinashNAS.local:8443 --insecure \
  --email <bootstrap email> --password '<bootstrap passphrase>' \
  --dir scripts/validation/out --files img001.dcm,img002.dcm,img003.dcm \
  --accession ACC-TEST-0001
docker compose --profile nas run --rm worker node apps/worker/dist/main.js once      # full CMD: a bare `once` replaces the whole command and the entrypoint turns it into `node run` — MODULE_NOT_FOUND
```

The `--api` host must be `$TR_TLS_HOSTNAME`, never `localhost`: Caddy's internal CA
issues a certificate for that hostname only, so a loopback URL makes every request
fail the handshake with `tlsv1 alert internal error`. From the NAS itself use
`--resolve "$TR_TLS_HOSTNAME:8443:127.0.0.1"` (a `.local` name does not resolve from
a NAS shell); from any workstation on the LAN, mDNS resolves it already.

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

## 7b. Run the upload agent, which is the thing a site installs on its own machine

`run-p1-flow.py` above behaves perfectly. A center's CT console does not: it writes into a folder
while the scan is finishing, its share drops its handle, the machine reboots nightly, and the
person standing next to it is a radiographer, not an operator. `apps/agent` is the binary that
lives there.

```bash
pnpm --filter @telrad/agent build          # writes apps/agent/dist

printf '%s' '<the token from POST /v1/sites/:id/tokens>' > /etc/telrad/agent-token   # mode 600
node apps/agent/dist/main.js \
  --watch /mnt/modality-export \
  --api https://telrad.<your-domain>:8443 \
  --token-file /etc/telrad/agent-token \
  --hints '{accession}-{date}' \
  --interval 20
```

Run it once first, and read what it says it would do:

```bash
node apps/agent/dist/main.js --watch /mnt/modality-export --api https://telrad.<your-domain>:8443 \
  --token-file /etc/telrad/agent-token --dry-run --once
```

Five things about its behaviour are decisions, not defaults to tune:

- **it deletes nothing.** The export folder stays the center's copy until the archive confirms the
  study; the agent keeps `telrad-agent-state.json` beside the folder instead. If you want files
  moved out of it, do that on a schedule you control, after the study is linked.
- **it takes a folder when two scans agree**, and only after every file in it is older than
  `--settle` (60s). A folder that is still being written is left for the next pass. `--once` (for
  cron) has no second scan, so there the settle window carries it alone — widen it if you schedule
  the agent every five minutes.
- **a folder is a study.** One directory becomes one batch; a study bigger than the server's cap is
  split into numbered parts rather than refused. Nested folders are separate studies.
- **a half-sent study resumes, it does not start again.** If the network dies mid-folder, the same
  batch id is filled and sealed on the next pass, and the files already on the server are not
  uploaded twice. Failures back off per folder (5, 15, 60, 300, 900 seconds) rather than retrying
  every interval against an api that is down.
- **its log does not contain the folder name.** Export folders are routinely named after the
  patient, and this log is the file somebody attaches to a support email. `--log-names` is the
  opt-in for debugging your own machine. `--hints` has three tokens — `{accession}`, `{date}`,
  `{modality}` — and there is deliberately no patient or MRN token; a folder name that does not
  validate against the template simply sends no hint, because a wrong accession would attach the
  images to somebody else's order and a missing one only means the images wait in the orphan queue.

The credential never goes on the command line: `--token` is refused, because argv is readable by
every other account on a shared workstation and lands in shell history. Use `--token-file` (mode
600) or `TELRAD_AGENT_TOKEN`. The agent also refuses an `http://` api unless you pass
`--allow-insecure-http`, because that token rides on every request.

Prove the whole thing end to end on a throwaway stack, from an empty database:

```bash
bash scripts/validation/run-agent-live.sh            # and --keep to leave it up
```

It generates two real studies — one folder named like an accession, one named like a patient —
and asserts the settle gate, the two-scan rule, the resume, the `README.txt` that came with the
export being quarantined rather than dropped, a dead api leaving nothing duplicated, and the
linked study's `instance_count` matching what the node reports.

## 8. Run the console

The board is a static build, and Caddy serves it from `apps/web/dist` on the same
origin as the api — which is not a style choice. The session cookie is `HttpOnly` and
`SameSite=Strict`, so a second origin would mean either weakening that or storing a
token where any browser extension can read it.

```bash
pnpm --filter @telrad/shared build       # on the workstation: pixels/report types
pnpm --filter @telrad/web build          # on the workstation: writes apps/web/dist
```

A Container Manager host has no node or pnpm, so on the NAS itself either copy
`apps/web/dist` from the machine that built it, or build it in a throwaway
container — same result, nothing left behind:

```bash
docker run --rm -v "$PWD:/repo" -w /repo node:22-alpine sh -c \
  "corepack enable && pnpm install --frozen-lockfile=false \
   && pnpm --filter @telrad/shared build && pnpm --filter @telrad/web build"
docker compose --profile nas up -d caddy # serves it at https://$TR_TLS_HOSTNAME:8443
```

The shared package is built first on purpose: `@telrad/shared/pixels` resolves
through `packages/shared/dist`, and on a fresh clone that dist does not exist —
the web build fails with `Cannot find module '@telrad/shared/pixels'` until the
shared package is compiled.

Build it before starting Caddy. An empty `apps/web/dist` mounts fine and answers 404
for every page, which looks like a broken deployment rather than a missing build step.

Browse `https://$TR_TLS_HOSTNAME:8443`, never the NAS's IP — the internal
certificate is issued for that name alone, so an IP URL is refused at the
handshake. The name must resolve to the NAS (a DNS record or the workstation's
hosts file), and the first visit shows a certificate warning because the CA is
Caddy's own; on a managed workstation, import `TR_RUNTIME/caddy/data/pki`
root certificate once instead of clicking through on every reader's machine.

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

What has to be true of a report. `scripts/validation/run-report-flow.py` drives the whole
lifecycle over HTTP — draft, sign, countersign, deliver, amend, a critical finding declared and
answered, and a signed clock pushed past its deadline — in five phases (`--phase prepare`,
`accept`, `check`, `critical`, `late-clock-after-sign`), and the points worth re-checking by hand
with two reader accounts:

- **a signature needs words.** Leave Impression empty and Sign is refused, naming the field.
  The button is greyed for the same reason: the browser applies
  `packages/shared/src/report.ts`, the same module the route asks. If a client could sign a
  blank impression, the rule was only ever decoration;
- **a signed report cannot be edited.** Try to save text on one — the answer is
  `signed_report_is_immutable`, and the only way to change it is an amendment, which starts a
  new version carrying the words it corrects. The old row keeps both names and both
  timestamps: `select version, state, signed_at, verified_at from telrad.reports where
  study_id = N;` must show v1 `amended` and v2 live. If a version ever disappears, an
  amendment was written as an edit;
- **three different people are needed for three different acts.** The author signs; a
  *different* reader with a grade at least the author's countersigns; and an amendment must
  come from a grade **strictly above** the author of the version being corrected. Each
  refusal names itself (`self_review`, `grade_below_author`, `grade_not_above_author`). A
  database `CHECK` also forbids one id from holding both names, but that one answers 500, so
  the route asks first;
- **the reviewer must be able to see the images.** A reviewer is never the holder of the case
  — exactly one live assignment per study is the routing rule — so the viewer answers
  `reportAccess: {as: "review"}` and opens them anyway. A reviewer who cannot see the study
  is signing on the author's word, which is what the second name exists to prevent. An author
  keeps the same door (`as: "author"`), because signing takes the case off their desk;
- **signing stops the clock and frees the queue.** `sla_clocks.signed_at` gets a value — the
  one column the escalation sweep refuses to fire past — the assignment moves to `completed`,
  and the case disappears from `/v1/my/work`. An assignment left `accepted` after its report
  is signed keeps counting against `max_queue_size`, and that reader silently stops receiving
  work while the board paints them at capacity;
- **lateness is measured against the signature.** A report signed after its deadline is a
  breach. A report signed *before* it is never a breach, even if the deadline is rewritten
  afterwards (an orphan relinked, a contract renegotiated). If a signed-on-time case appears
  on the late board, `isBreached` has gone back to comparing the deadline with the wall clock;
- **an amendment does not restart the clock.** Deliberate: the center was answered on time by
  the first signature, and a correction must not become a breach the dispatcher widens a pool
  for;
- **delivery is a desk act, and it is where the two remaining rules bite.** A radiologist —
  including the one who signed — gets 403 on `POST /v1/reports/:id/deliver`, and the desk role
  gets 200. A report whose sub-specialty needs a second name refuses with `review_required`
  until a reviewer exists, which is the first time `sub_specialties.requires_reviewer` stops
  being a caption on a screen. A report carrying a critical finding nobody has answered refuses
  with `critical_unacknowledged`, and the board's row says so instead of hiding the button.
  Check the ordering: with both gaps present the answer is `review_required`, because that is
  the nearer thing the desk can fix;
- **the delivered document is reproducible, and its hash is the claim.** Download the PDF twice
  and diff the bytes; `reports.pdf_sha256` must equal the hash of what the route just sent.
  Nothing operational is printed on the page — the first version printed `Delivered <timestamp>`
  and rewrote the document whose hash had just been recorded, which the live run caught as
  `aef3e83e… vs 667f0e5c…`. The one deliberate exception is the superseded banner, and the
  download audit then carries `matchesRecord: false` rather than pretending;
- **a critical finding is not a notification until a named person answers.** Declare one as the
  report's author (`POST /v1/criticals`, a code from `GET /v1/criticals/catalogue`, the channel,
  and the name of who was told) and the report becomes undeliverable. A reader cannot record the
  acknowledgement — that is a desk act, and it is the guard that stops a reader closing their own
  loop. `notified_at` is written by the server and never accepted from the caller, so a service
  cannot backdate a call into last night's compliance. Then run
  `pnpm --filter @telrad/worker criticals-once` after moving a `notified_at` into the past: the
  row gets `breached = true` and one `critical.breached` audit row. A finding acknowledged *late*
  is stamped too — if only open loops were swept, the breach would depend on when a process
  happened to wake up.
- **a released report tells the clinic, and the telling is not the release.** With `TR_SMTP_URL`,
  `TR_SMTP_FROM` and `TR_PUBLIC_URL` set, `POST /v1/reports/:id/deliver` inserts a
  `channel='email', status='pending'` row and returns; `pnpm --filter @telrad/worker notify-once`
  drains it. Four things to check, because these are the four a mail feature usually misses. Read
  the message **in the sink**, not from our status column: it must contain no patient name, no MRN
  and no report text — a body that fails that guard is marked `dead` with
  `patient_identifier_in_body` and is never retried, because a leak retried five times is five
  leaks. Point `TR_SMTP_URL` at a port nothing listens on: the row must come back `failed` with
  `attempt_no = 1` and a `next_attempt_at` in the future, not hammered again, and the fifth attempt
  must end it as `dead` — listed by `GET /v1/reports/outbox`, because a queue that quietly stops
  trying is worse than no queue at all. Unset `TR_SMTP_URL` entirely: the sweep must write *nothing*
  and report `skipped`, so a box with no relay keeps its backlog rather than destroying the record
  of which clinics were never told. And check the sentence about signatures against the row: it
  comes from `reports.reviewer_user_id`, not from the sub-specialty's rule — the live run caught the
  first version reading the rule, and it told a clinic that a report with one name under it had two.

What is not built here yet: **a message that carries the document.** The notice is a pointer —
accession, version, signature time, portal link — never the PDF and never the findings, because an
email body is copied, backed up and indexed by everything between a relay and a court. There is no
WhatsApp or SMS channel: a WhatsApp Business account needs Meta verification and pre-approved
templates, and it would move the fact of a patient's study into a third party's store outside the
DPDP envelope. No telephone call is placed by the product — `critical_events` records the call a
reader says they made and the answer a desk says it received — and nothing beyond "a relay accepted
this" is known about the clinic's side. Not built either: billing, payouts, and any pager.

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

Then take the database away from a running API and ask what the reading room sees:

```bash
pnpm build && bash scripts/validation/run-fault-injection.sh
```

It builds its own throwaway Postgres on port 5413, bootstraps a fixture owner, starts
`dist/server.js` on 3101, stops the container under it and checks that the request
answers `500 {"ok":false,"error":"internal_error"}`, that `/health/live` is still
answering from the same pid, and that reads return without a restart when the database
comes back. The check exists because Express 4 does not await a route handler: before
`ah()` in `apps/api/src/handler.ts`, one bad query ended the process and the container
restart hid it. It removes its own container on the way out and touches nothing you
have deployed.

## 10. Backup before any real study

Three copies, and the third one off the premises. The live stack is the first.
The second is `scripts/backup/backup.sh`: a `pg_dump` of the telrad schema, a
tarball of the Orthanc store, and a count manifest frozen at backup time —
with a keep-newest-7 prune, so the NAS folder stays bounded as the store
grows. Run it nightly from DSM Task Scheduler (scheduled task, user-defined
script, run as the deploy user):

    cd /volume1/docker/telrad && sh scripts/backup/backup.sh

Prove every artifact with `scripts/backup/restore-drill.sh`, which restores
the newest pair into sealed, network-less throwaway containers and counts
every table and image against the manifest — on this repository's NAS that
measured 219 s RTO with 37/37 tables matching.

The third copy is Duplicati (`--profile backup`): it pushes `backups/` to a
machine the NAS cannot remount read-write — here the clinic Windows PC over
SFTP — AES-256-encrypted with a passphrase only the operator holds, on its
own nightly schedule and retention. Set the GUI password before first start
(`TR_DUPLICATI_PASSWORD`); the UI can read every backup. When the platform
moves to the cloud VM, Duplicati moves with it and its destination becomes
object storage, taking the NAS out of the backup path entirely. Until a
restore has been rehearsed from the third copy too, this deployment holds
test data only.

## 11. Publishing with a Cloudflare Tunnel (optional)

The deployment is a LAN service by default: the console answers on
`https://$TR_TLS_HOSTNAME:$TR_HTTPS_PORT`, and raw-IP URLs work too (`https://<nas-ip>:8443`)
because Caddy answers SNI-less handshakes with the named certificate — the browser
warns and one click-through admits the visitor, the same as for the name.

A public name rides a cloudflared tunnel: one outbound connection, public TLS
terminates at Cloudflare, and the origin face is Caddy's port 8080, published to
host loopback only — plain HTTP never leaves the machine.

If a dashboard-managed connector already runs on this host (network mode host),
there is no new tunnel and no token:

1. Zero Trust dashboard → Networks → Tunnels → the existing tunnel →
   Public hostname → add `pacs.example.com`, service type `HTTP`,
   URL `localhost:$TR_TUNNEL_PORT`.
2. `docker compose --profile nas up -d caddy` publishes `127.0.0.1:$TR_TUNNEL_PORT`.

Otherwise create a dedicated tunnel: Networks → Tunnels → Create (cloudflared);
public hostname as above but service `HTTP tr-caddy:8080` (the docker-network
name); put its token in `.env` as `TR_TUNNEL_TOKEN` (never commit it) and start
the in-stack connector: `docker compose --profile nas --profile tunnel up -d tunnel`.

The console login is then the only gate on the public name; a Cloudflare Access
policy in front of it is the next layer if that ever feels thin. When the public
name becomes the primary address, update `TR_PUBLIC_URL` so emailed links point at it.

## What is not here yet

Built and proven on test data: the on-panel board and its heartbeat, the dispatcher that
offers a case only to a green reader who covers it, the reader's own worklist with accept
and decline, the escalation stages that widen the pool and stamp a breach, the operator's
late board, manual assign with its reason and its reported coverage mismatch, a viewer
that shows a reader the case they hold — grayscale, window and level, series strip, slice
scroll — with the pixels verified against what the node actually stores, the report desk —
draft, sign, a second name from a different reader, an amendment that supersedes the signed
version instead of editing it, and release to the clinic as a PDF whose SHA-256 is recorded and
re-verified on every later download — and the critical-finding loop: a reader declaring a
condition from a closed list and naming who they telephoned, the report held undelivered until
somebody at the referring end is recorded as having answered, and the worker stamping a breach
on a call nobody answered while a call answered late keeps its breach too.

Not built: **a message that carries the document.** The notice that *is* built goes like this: a
release queues an email to the address recorded on the referral, a worker sends it on a backoff
ladder, a body that carries a patient identifier is killed rather than sent, and a relay that never
accepts ends in a `dead` row somebody is shown. It is **proven against a local sink (Mailpit) and
never against a real provider**, so whether a government hospital's domain accepts it, or a
greylist delays it by an hour, is unmeasured — and the message is a pointer, never the PDF and
never the findings, so a referring clinic without a login still cannot read the report from the
email alone. The critical loop records a telephone call, it does not place one, and an
acknowledgement is a name typed by a desk rather than an identity proved. Not built either:
WhatsApp, SMS or HL7 — a WhatsApp Business account needs Meta verification and pre-approved
templates, and it would move the fact of a patient's study into a third party's store outside the
DPDP envelope. Not built either: billing and payouts, and any pager — `alert_ops` and
`notify_center` are recorded, not sent. Not a **diagnostic** viewer either: what exists
has no hanging protocols, no MPR, no measurement or annotation tools, no cine, and shows one
series at a time; it is enough to look at a study and not enough to sign one in a reading
room that expects those tools.
The upload *agent* exists (`apps/agent`) and is proven against this stack's own api from a real
watch folder of real Part-10 files — see §7 for the command. What has not been done to it is the
list that matters before a center relies on it: it has never run against a modality's actual export
folder (those names are invented by the vendor's software, and the `--hints` template is the
operator's way of telling the agent what convention it found), never run for the weeks-long
unattended stretch a NAS-to-cloud deployment expects, never packaged as a Windows service or an
installer, and never talked to a real TLS endpoint — every assertion here passed `
--allow-insecure-http` because the validation api is loopback cleartext. README at the root lists
the phase plan; docs/ARCHITECTURE.md states what exists, including the open items it names:
**a declined case is never asked again**, **a widened
offer has no ceiling**, **nothing escalates a report that is waiting for its second name**
(it is listed, blocked and visible, but untimed), the delivered document is regenerated rather
than stored, the viewer ships text-shaped pixels and their byte cost, and frames are not
individually audited.
