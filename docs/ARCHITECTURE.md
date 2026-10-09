# Architecture

Release line: P0. The status inventory at the end is the part to read if you only
read one section.

## What the system is

A multi-center tele-radiology service. Centers send studies; the platform resolves
each study to a tenant and an order; a dispatcher offers it to eligible
radiologists; two names sign the report; it is delivered and billed. Standalone:
no shared database with any other product, no dependency on an external AI layer.

## Five decisions that shape everything else

**1. A study's location is a node reference, never a hostname.**
`studies (storage_node_id, node_pk, study_instance_uid)`. Every image URL is
resolved at request time through `storage_nodes`. This is what makes the
NAS→cloud move an `update` plus a bulk copy instead of a rewrite of clinical
history. It costs nothing today and is close to impossible to retrofit.

**2. Tenant isolation is applied in the query layer, not in the UI.**
`patients.mrn` is unique per tenant, and two centers' same-named patients are
never merged — a cross-tenant merge would leak one center's history to the other.
A center-scoped principal can only ever see its own `tenant_id`, and a request for
another tenant's row answers 404, not 403.

**3. Identity resolution has hard floors.**
The weighted score in `packages/shared/src/match.ts` is a hint; the rules are the
floors: a contradicting name, date of birth or modality excludes the candidate
entirely, and two candidates within 0.1 become `ambiguous` rather than a guess.
Anything not `linked` is unassignable. `apps/worker/test/ingest.test.ts` asserts
the negative cases, because the failure this prevents is a signed report on the
wrong patient.

**4. The audit log is chained and covers reads.**
Each row hashes its predecessor's hash, so an edit is detectable by recomputation
(`pnpm verify-audit`). Reads of patient data are audited, since the question a
center or a regulator asks is "who looked at this study", which a write-only log
cannot answer. The chain is tamper-*evident*, not tamper-proof: it only means
something next to the offsite export required in README-FIRST-DEPLOY.md §8.

**5. One compose tree, two profiles.**
`--profile nas` publishes 5690 and 8443; `--profile cloud` publishes 104 and 443
and moves the ingest node. No service may assume it is running on the NAS: the
proxy config lives in `infra/caddy/` rather than in DSM, and `${TR_RUNTIME}` is
the only place a path appears.

## Rules that are not style preferences

- No native-compiled dependency in the server path. `node:crypto` scrypt for
  passwords, built-in `fetch`, so a Linux CI container and a Windows laptop
  resolve the same tree.
- Secrets fail closed. `apps/api/src/env.ts` refuses to boot on a placeholder or a
  short value; there is no "warn and continue".
- `apps/api` is the only writer of clinical state. The worker writes ingest rows, the
  escalation state of a clock it measured, and audit rows — and it never creates, moves
  or releases an assignment. Only a reader's own request can put a case on their desk,
  which is what keeps the dispatcher from becoming a second place where work is assigned.
- **Green means "will pick this up now", never "has an account".** Presence is a
  heartbeat the open console tab sends every twenty seconds, the state the reader
  declared, and whether their queue has a free slot — all three, computed by one pure
  function (`packages/shared/src/presence.ts`) that the board and the dispatcher both
  call, so they cannot disagree about who is routable. A tab left open
  overnight goes red on its own. Amber is deliberately separate from red: a reader at
  capacity and a reader who has gone home are different things to phone about at 2 a.m.
- Clocks open only for a study that is both linked and complete. A deadline on a
  guessed sub-category measures the wrong thing. The clock opens on the poll that
  *finds* it complete, not the poll that inserted the row, and is measured from the
  study's first-sight time — Orthanc keeps calling a freshly arrived study unstable
  for about two minutes, and the poller runs every ten seconds.
- A manual link is the one exception to the completeness gate, and it is deliberate:
  naming the order a study belongs to is an assertion of responsibility, so its clock
  starts then, at the **order's** priority — but still counted from `received_at`, so
  three days in the orphan queue are never converted into three days of fresh time.
- A report is versioned by insertion. Amendment writes version n+1 signed by a
  strictly higher grade; the old row keeps its signature pair.
- **An offer is not a lock.** The dispatcher puts a case in a reader's queue; only
  `POST /v1/assignments/:id/accept`, called by that reader, writes `accepted_at` and
  mints the lock token. Nobody can be assigned work they have not taken, and the token
  is returned exactly once — a worklist that re-echoed it would make a screenshot a
  credential. An offer nobody accepts lapses (5 minutes) and rotates, and a rotation
  never re-asks the same reader for the same case.
- Coverage is a claim, not a default. `clinician_profiles.sub_specialty_codes` and
  `modality_codes` gate routing, and **an empty list routes nothing**; `*` is the only
  way to say "everything". A profile nobody filled in must not quietly become the
  reader who receives every spine MRI.
- A study is re-read for completeness rather than trusted from one look. Orthanc flips
  `IsStable` about two minutes after the last instance and emits **no change event** for
  the flip, so `recheckStalled` asks `/studies/{pk}` again for anything still flagged
  `study_not_complete`. Without that pass a center that uploads a whole study in one
  batch is filed, flagged and never looked at again — and because an incomplete study is
  deliberately not dispatchable, the routing queue would stop moving while every other
  signal still looked healthy. This was found by running the dispatcher, not by reading
  the code.
- **Escalation stages are fractions of the window, and widening relaxes capacity and
  nothing else.** `packages/shared/src/escalation.ts` reads `escalation_rules` by
  `at_elapsed_pct`, so a center that renegotiates four hours to two does not re-edit
  three timers, and a tenant's own rows *replace* the platform's rather than adding to
  them. The only thing `widen_pool` permits is a case going to a reader who is present,
  covers the study, and is already at capacity. It never reaches a paused reader, never
  reaches a stale tab, and never reaches a reader whose profile does not list the
  sub-specialty. Both halves were measured on live infrastructure: the chest film whose
  only cover had just filled the one-slot queue they declared was offered anyway
  (`escalate … actions=widen_pool:1`, `dispatch widened=1`), and the spine MRI whose only
  full cover was paused stayed unheld through the same stage.
- **A pass catches up; it does not queue.** A case that crossed two thresholds while the
  worker was stopped fires both stages in the next sweep, lowest first, each with its own
  `sla.escalated` audit row. A schedule that advances one stage per tick does not report a
  different story, it just reports it late — and on a clock measured in hours, "late" is
  the whole point of the rule. `breached` is stamped by a conditional update, so it is
  written exactly once however many passes follow.
- **`alert_ops` and `notify_center` are recorded, not sent.** They write an audit row and
  appear on the operator's late board. There is no pager and no SMS gateway in this
  repository, and an action named "alert" that silently did nothing is the kind of
  fiction a contract audit is designed to catch.
- **A manual assign is a person taking responsibility, and the mismatch is shown.**
  `POST /v1/assignments` requires a reason, records `escalated_by`, and returns the
  coverage mismatch in the response *and* in the audit detail rather than treating an
  override as normal. Measured live: assigning a spine MRI to the chest reader answered
  201 with `warning: "Dr Chest does not list sub-specialty mr-spine or modality MR"`, and
  the same study answered 409 `already_assigned` on the second submit.
- **The chain hashes what the row will read back as.** `canonicalise` in
  `packages/shared/src/audit.ts` hashes a `Date` in an audit detail as its ISO string,
  because jsonb stores a string. Hashing it as an object yields `{}` at write time and a
  real value at verify time, and `verify-audit` broke at row 46 — the first line written
  by the worker, which was also the first line that carried a timestamp. The api's own
  rows had never done that, so the trap sat in the code for as long as only one process
  wrote the chain.

- **The window is computed in the browser because the node refuses to compute it.** This
  was measured twice on the pinned container before it was believed: `/instances/{id}/preview`
  with `size`, `min`, `max`, `modality` and `quality`, and `/frames/{i}/image-uint8` with
  eight different windows, returned **one identical PNG** in each case (`distinct outputs: 1`).
  So the api ships stored pixel values and the console applies rescale and window here —
  which is also what makes brightness and contrast adjustable at all on a NAS with no GPU.
- **`/frames/{index}/matlab` is the only endpoint on this build that answers with numbers.**
  `image-int16` and `image-uint16` answer with a 16-bit PNG (a browser cannot window a
  canvas that has already been downconverted to 8 bits), and `matlab` answers with text in
  the shape `double([ r0c0 r0c1 … ; r1c0 … ])` — **rows separated by semicolons**, which
  is invisible in a truncated print and broke the first parser exactly that way. The unit
  fixture now carries the semicolons and the live check compares 4,096 values against the
  arithmetic the fixture wrote, because "it parsed" is not "it parsed correctly".
- **Core REST does not resolve a DICOM UID in the path.** `GET /studies/1.2.3.960` answers
  404 while `/studies/<internal-pk>` answers 200, so the viewer runs on the `node_pk` the
  ingest poller stored at first sight. Also 404 on this build, and not to be re-guessed:
  `/instances/{id}/download`, `/thumbnail`, `/headers`, `/shared-tags`,
  `/studies/{pk}/preview`. Tags come from `/instances/{id}/tags`, structure from
  `/studies/{pk}/series` (which arrives with each series' `Instances` already expanded).
- **A pixel request is authorised twice, and the second time is not about the user.** The
  caller must hold the study — offered, accepted or reading, since looking is how a reader
  decides whether to accept, and an accept that had to be blind is the one thing the
  padlock rule forbids. Then the *instance* must be one of that study's instances: Orthanc's
  ids are unguessable, and unguessable is not an authorisation check. A malformed id is
  refused before the node is asked at all (`NODE_ID` regex), so a path traversal attempt
  never reaches a URL builder.
- **One study structure read per minute, not one per scroll.** `/studies/{pk}/series` is
  cached in the router for 60 s (`TREES_MAX` caps the map). Without it a 300-slice CT asks
  the node for the same answer 300 times. A study worth opening is already complete —
  nothing dispatchable is still arriving — so the staleness is not clinical.
- **Frames cross as `int16-le` with `no-store`.** The headers carry the format and the
  pixel count so the browser does not have to guess what it is holding, and a cached frame
  would outlive the assignment that made it readable.

## Known open items, stated rather than implied

- **One failed query takes the whole api down.** Express 4 does not catch a rejected
  promise from an `async` handler, so a database error inside any route becomes an
  unhandled rejection and Node exits the process. This has now happened twice, in the
  same way, in code I wrote: a `Date` interpolated into a raw `sql` template reaches
  postgres.js untyped and throws while encoding the parameter. The first was the panel
  read; the second was the dispatcher's roster subquery a week later, which killed the
  api mid-verification. `restart: unless-stopped` hides it as a two-second blip and the
  in-flight requests of every connected reader fail with it. The fix is a `ah()` wrapper
  that forwards rejections to `next(err)` at every route registration — mechanical,
  ~30 call sites, deliberately not done in a hurry. Until it is, `/health/ready` plus a
  restart count is the only evidence, and **any new raw `sql` fragment that takes a
  timestamp must bind `date.toISOString()` with an explicit `::timestamptz` cast.**
- **The image node in this deployment cannot serve a real viewer, and the config says it
  can.** `infra/orthanc/orthanc.json` contains a `DicomWeb` block with `Enable: true`, but
  `/plugins` on the pinned container answers `["explorer.js", "gdcm", "orthanc-explorer-2"]`
  — the DICOMweb plugin is one of **33 `.so` files sitting in `/usr/share/orthanc/plugins-available/`**
  and only two are in `plugins/`. The config is therefore inert, `/dicom-web/` is not a
  route, and OHIF cannot be pointed at this node until the plugin is actually loaded and
  the result re-measured. That is a deployment step nobody has taken, and the section in
  the config file predates knowing it.
- **The viewer ships text-shaped pixels, and that has a price.** `matlab` measures 17,645
  bytes for a 64×64 frame against 2,027 bytes for the same frame as a 16-bit PNG — 4.3
  bytes per stored value. Scaled to a 512×512 CT slice that is roughly 1.1 MB of text per
  slice, per reader, per scroll. It is correct and it is slow. The fix is measured and
  available: fetch `image-int16` and inflate the PNG in the browser with `fflate` (already
  a worker dependency, pure JS, no native compile) — which needs the IDAT filter types
  undone for 16-bit grayscale, and must then agree with the `matlab` numbers to be trusted.
- **Nobody audited the individual frames.** `view.open` is written when a case is opened
  and that is the record of who looked. A reader scrolling 300 slices writes one audit row,
  deliberately — 300 rows per case would make the chain unreadable — but it means the
  answer to "who saw this specific image, when" is "they opened the study at 02:13", which
  is a weaker claim than the rest of this audit trail makes.
- **This is not a diagnostic viewer.** No pan, no zoom beyond the browser's, no magnifier,
  no measurement or annotation tools, no MPR, no hanging protocol, no prefetch of the next
  slice. It draws the pixels with an adjustable window and it scrolls. The gap between that
  and what a radiologist signs a report against is the DICOMweb item above, not more canvas
  code.

- **A declined case is never asked again, and widening cannot fix that.** Rotation
  refuses to re-offer a study to a reader who has already been asked, so the chest film
  a reader sends back with a reason stays in `/v1/dispatch/unassigned` with
  `already_offered` as its explanation at every stage, up to and including breach. That
  is deliberate for the automatic path — a case cannot be forced back onto the person who
  just refused it — and the manual assign exists to be the way out. What is missing is
  the other way out: nothing re-offers it after the reader's own queue empties, so a
  decline at 1 a.m. needs a human awake at the board.
- **A widened offer has no ceiling.** `widen_pool` lets an at-capacity reader take one
  more case, and in the live run the same chest reader ended up holding three accepted
  studies against the one-slot queue they had declared — one ordinary offer, one widened
  offer and one manual assign, each of which checked coverage and presence and none of
  which checked a limit. An over-capacity queue is a clinical risk and the number needs a
  stated maximum (one over? two over? never for STAT?) before a real reader is on it.
  `assignments_live_lock_uq` will happily let it keep happening.
- **A router mounted at `/v1` guards paths it does not own.** `r.use(requireAuth)`
  inside such a router runs for *every* `/v1/...` request, so a radiologist polling
  `/v1/presence` was answered 403 by the sites router's owner-only check, and an agent
  token polling `/v1/uploads` was answered 401 by a session guard. Both are fixed by
  `scoped()` in `apps/api/src/auth.ts`, which applies a guard only to the path prefixes
  that router declares. Mount order is no longer load-bearing, but a new router must
  still list its own prefixes — forgetting that reintroduces the bug silently.
- **An unknown `/v1/...` path answers with Express's HTML 404, not JSON.** Harmless
  today — the console shows "feed lost" — but every other failure mode in this API
  speaks JSON, and a client should not have to special-case one.

- **A study that arrives on the upload channel is attributed by an Orthanc label, and
  Orthanc's label rules are load-bearing.** The write verb is `PUT
  /instances/{id}/labels/{name}` — `POST` to that path answers 405 — and a name may
  only contain `[A-Za-z0-9_-]`, up to 64 characters, or the node answers 400. That is
  why labels are `telrad-batch-<id>` and not `telrad:batch:<id>`, and why
  `apps/worker/src/labels.ts` owns the spelling instead of leaving it to memory. A
  REST-pushed file has no `RemoteAET`, so if the label is ever refused the study lands
  in the orphan queue as `site_unresolved` rather than being guessed at; the instance
  is still recorded as `pushed`, because the bytes really are archived.
- **Priority on the automatic path is inferred, not ordered — and the escalation engine
  now sits on top of the inferred one.** `classifyStudy` reads STAT/URGENT out of DICOM
  text and the matched order's own `priority` is never consulted, so an urgent order
  delivered by a center that writes no priority text is clocked as routine — while the
  *manual* link to that same order clocks it urgent. Measured in the escalation run:
  `ACC-ESC-B` was ordered urgent, its study row came out routine, and its window was the
  routine 240 minutes. The stages that fired on it were the routine stages. Decide which
  source wins before a center is billed against a clock nobody agreed.
- **Two tenants claiming one instance is refused, but only proven by unit test.** The
  rule is in `attributeByBatch`; it has not been exercised live, because doing that
  needs a second tenant filing the same pixels.
- **`studies.instance_count` counts what the poller saw, not what is stored.** Rewinding
  `ingest_cursors` to re-scan inflates it, and `bytes` with it. Nothing in the product
  quotes those numbers to a center yet; before it does, the count should come from
  Orthanc's study statistics instead of from a per-poll increment.
- **`DicomAet` in `infra/orthanc/orthanc.json` is not honoured by Orthanc 1.13.0** —
  the boot log says `DICOM server listening with AET ORTHANC` while the config asks
  for `TELRAD`. Tenant routing does not depend on it, because provenance is taken
  from the *sending* AE title (`metadata/RemoteAET`, verified returning
  `TELRAD_TEST`), but no center may be told that our SCP has an AE title until the
  setting name is corrected.
- **Liveness on this image is `/system`, and there is no shell tool to probe it with.**
  `/ping` answers 404 even with a valid credential (401 without one), `/systems`
  answers 404, and the image contains neither `curl` nor `wget` — only `python3`. An
  `apt-get install`-free healthcheck therefore has to be the one in `compose.yaml`,
  and any new probe must be measured against a running container before it is written
  down.
- **Orthanc's own `/settings` and `/tools/list` answer 404 on this image**, so
  configuration cannot be inspected over REST; the boot log is the only surface.
- **The image plane is pinned by digest, not by tag, because no version tag exists.**
  `orthancteam/orthanc` publishes CalVer tags (`26.9.1`, `latest`) and there is no
  `1.13.0` tag — 1.13.0 is the build inside the image. A `.env` that put the version
  in the image slot failed the pull with "not found".
- **The image-plane index is Orthanc's built-in one, not PostgreSQL.** The
  orthancteam image loaded only `orthanc-explorer-2` and `gdcm` from its default
  plugin path with this config mounted; enabling the PostgreSQL index plugin is a
  P1 performance task with its own verification, not a setting already switched on.
- Study-level provenance gating is in place (`IsStable` → `study_not_complete`,
  no clock, off the queue), but a study that never becomes stable has no timeout
  yet; it will sit in `studies` flagged forever.
- Retention tiers are a column, not a job. Nothing moves bytes yet, and the
  policy table is unread. That is P5 work, and the commercial reason it matters is
  below.

## Commercial constraints that shape the schema

Competing Indian imaging clouds appear to bundle roughly one year of online storage
per center. The `retention_policies` and `studies.retention_tier` columns exist so
longer retention can be *sold as a contract term with a cost behind it*, rather than
promised as unlimited and absorbed silently on your own disk. Two opposing forces
are encoded here: retention is a differentiator buyers ask for, and DPDP's
storage-limitation expectation argues that identifiable images kept past need are a
liability surface. The resolution is a per-tenant policy with a documented purge
schedule, which is why retention is data and not a constant.

## Status inventory

| Component | State |
| --- | --- |
| `packages/db` schema (31 tables) + `migrations/0000_*.sql` | **Applied to a real PostgreSQL 16**; 31 tables created in `telrad`, nothing leaked into `public` |
| `packages/shared` match + classify + two-signature rules + audit chain | Built; the package carries **97 assertions across six files** (order matching, classify + enums + the audit chain in one, presence, the routing rule, the escalation rule, request validation). Region codes derive from (modality, region); obstetric is tested before abdomen on purpose |
| `apps/api` health, login/session/logout, tenant-scoped study reads, audit read | Built and **exercised over HTTP**: login issued a session cookie, a wrong password got 401, an unknown `state` param got 400, an unauthenticated read got 401 |
| `apps/api` bootstrap + `verify-audit` | Ran against the test database: owner + tenant + node + catalogs written, audit chain verified `rows=4 broken=0` |
| `apps/api` order and patient entry, site registration, agent tokens, upload batches, orphan queue | Built and **exercised over HTTP** by `scripts/validation/run-p1-flow.py`, which now drives the agent steps with a token and **no cookie jar** — the first version of that script reused the console session and hid a defect that made the whole upload channel unreachable for an agent |
| `apps/worker` inbox → Orthanc for the **upload channel** | **Proven end to end**: agent opened a batch, PUT three instances (one rejected for a bad sha256 before it was stored), sealed; the worker pushed 3/3 and labelled each with the batch id; the poller read the label, attributed tenant 1 / site 1, linked the study by accession at score 1.000, and opened one clock at first-sight + 120 minutes. A zip batch exploded into its three members and labelled them the same way |
| `apps/api` orphan queue, manual link and unlink | **Proven live**: a second study uploaded with an accession no order carried (`ACC-NO-ORDER-777`) arrived as `orphan` inside the right tenant, `GET /v1/orphans` showed it **with the batch label as its provenance**, `POST /studies/:id/link` set it `linked`/`manual` at the **order's** priority, `unlink` returned it to the queue and deleted the clock it had not started, and relinking produced `deadline_at = received_at + 60 min` exactly. The `unlink` refusal while a radiologist holds the case (`assignment_open`) has not been exercised, because assignment is not built |
| `apps/worker` ingest against **live Orthanc 1.13.0** (C-STORE channel) | **Proven in the P0 run**: 2 synthetic CT studies sent by C-STORE, resolved to the tenant by `RemoteAET`, linked by accession, classified `ct-head`, 2 SLA clocks opened, cursor at `since=12`; a second poll created nothing |
| `infra/orthanc/orthanc.json` | Boots clean on 1.13.0 with authentication enforced (401 unauthenticated, 200 with the credential). `DicomAet` is not honoured — see open items |
| `compose.yaml`, `infra/caddy/Caddyfile` | `docker compose config` interpolates; **Caddy and the profiles have not been run** |
| `apps/web` console — the on-panel board | Built and **seen in a browser**: four seeded readers rendered red with "No signal · last signal 3m ago" after their heartbeats stopped, then Dr Anitha flipped to green "On panel" and sorted to the top **without a page reload** on the five-second refresh. Verified through the DOM (structure, counts, per-row reason); a screenshot was not available from this browser session, so the visual layout has not been reviewed by a human eye |
| `apps/api` presence endpoints | **Proven live**: `POST /presence/heartbeat` → green; a heartbeat *after* declaring `paused` stays amber, so presence cannot be refreshed back into availability; a reader holding one case with `max_queue_size = 1` → amber `at_cap`; `last_seen_at` backdated five minutes → red `idle` while `reader_availability.state` still reads `receiving`, which is the whole point; no session → 401, a non-reader session → 403 |
| Routing rule (`packages/shared/src/dispatch.ts`) | Built, 26 assertions: colour, tenant reach, coverage (empty = nothing, `*` = everything), night window against the tenant's own zone, capacity, rotation past readers already asked, and the widened path (at-cap only — a paused reader and a dead tab are never widened, and a reader without cover is never reached by it). Ties break on fewest open cases, then roster, then whoever waited longest. `readerPresence` is the same function the board calls, so a reader the board paints amber is not offered work |
| `apps/worker` dispatch sweep + offer expiry | **Proven live** with three studies on the real upload channel and five seeded readers: the STAT head CT went to Dr Green, the routine head CT to Dr Second *in the same tick* (Green was already holding one, and the sweep counts the offers it has just made), the chest to Dr Chest whom nobody else covers; Dr Paused (amber) and Dr Gone (declared `receiving`, no heartbeat for three hours) received nothing. A lapsed offer was withdrawn and rotated to Green as `attempt_no = 2` |
| `apps/api` accept / decline / my-work / unassigned | **Proven live over HTTP and in the browser**: accept returned a one-time lock token, wrote `assignments.accepted_at` *and* `sla_clocks.accepted_at`; a second accept got 409 `not_offered`; another reader's assignment answered 404, not 403; decline without a reason got 422 and with one released the case. `GET /v1/dispatch/unassigned` named the real gap on the declined chest study: `Dr Chest — already_offered`. Dr Second accepted through the console's own Accept button and the row moved to `accepted` |
| Reader provisioning (`cli add-reader`) | Built and used by the verification. Requires coverage lists, and refuses a stray argument: an unquoted `--name Dr Second` used to create an account called "Dr", which then won the alphabetical tie-break for the STAT case. Real routing bug, found through a real CLI trap |
| Console worklist for the reader | Built and **seen in the browser**: "Your cases" renders the live offer with Accept and Decline, a per-second countdown to the lapse, and the patient/modality/accession line; Accept was clicked and the database row confirmed `accepted` with a lock token. Layout has not been reviewed as an image — this browser gives no viewport |
| Viewer, reports, delivery, billing | Reports, delivery and billing are **not built**. The viewer exists and draws real pixels with an adjustable window, but it is not diagnostic-grade — see the open items |
| Orthanc capability probe (`.tmp` scripts, now `scripts/validation/probe-*.py`) | Run against the pinned digest before the viewer was designed: plugins loaded, tag endpoints, every rendering endpoint with and without a window, the numeric frame path and its exact text shape. The result is the six viewer rules above, and it overturned three endpoint names this repository's own worker had assumed |
| `apps/api` viewer routes (`/v1/view/:studyId`) | **Proven live over HTTP** (`scripts/validation/run-view-flow.py`, 17 assertions): the holder opens a case and gets its series with instance ids; the frame arrives as 8,192 bytes of `int16-le` with `X-Telrad-Pixel-Count: 4096` and `Cache-Control: no-store`, and **all 4,096 values equal the arithmetic the fixture wrote** (`0 of 4096 differ`); two slices of one study are two different images. Another reader gets 403 `not_your_case`, an instance belonging to somebody else's study gets 404 `not_in_this_study`, no session gets 401, a malformed node id gets 400 before the node is asked, and `frameIndex` out of range gets 400. An operator may open a case they do not hold, and every open writes `view.open` |
| Console viewer | Built and **seen in the browser** as the reader who holds the case: `ACC-VIEW-1` opens full-window with the header, the series strip (`HEAD NATIVE 3`), `slice 1 / 3` and `64×64 · 12-bit · windowed here`. The canvas holds an image, not a rectangle — **217 distinct grey levels, min 0 / max 255, mean 61.2**; ArrowDown moved to slice 2 (222 distinct, mean 58.7); narrowing the window to 60 collapsed it to 45 distinct levels, which is the window doing work on this side of the wire. The chest reader's DX film, which carries **no WindowCenter at all**, drew through the stored-range fallback at 80 distinct levels / mean 52.3 rather than going black. Console shows only the expected 401s from `/v1/auth/session` after a logout |
| Escalation rule (`packages/shared/src/escalation.ts`) | Built, 16 assertions: `elapsedPct` (unclamped above 100, zero-window measured as 100), `rulesFor` (a tenant's rows **replace** the platform's for that priority, they do not merge), `dueStages` (nothing fires on a signed clock, every missed stage returns in one pass), `widenStage` |
| `apps/worker` escalation pass | **Proven live on the real clocks.** Crossing 55 % produced `escalate checked=3 staged=2 breached=0 actions=widen_pool:2` and one `sla.escalated` row per clock with `actor_kind = system`; 80 % produced `alert_ops:1`; pushing a case from 65 % straight to 98 % fired **stages 2 and 3 in one pass** with two audit rows, and the deadline pass reported `breached=2`. An immediate second pass reported nothing, and the breach count in `audit_log` is still one row per clock |
| The widened offer, measured | The chest study whose only cover had just filled their one-slot queue was offered anyway (`dispatch widened=1`) and they accepted, taking the queue to **2 of 1**; the manual assign below made it 3 of 1, which is the open item rather than a surprise. The spine MRI whose only full cover was *paused* stayed unheld at the same stage: `poolWidened=true, status=blocked, nearest=Dr Paused (not_routable)`. Dr Green, green and idle for the whole run with the wrong lists, was never offered anything at any stage |
| `apps/api` late board and manual assign | **Proven live over HTTP**: `GET /v1/escalations` listed only clocks with something to say (`{open:3, late:0}` before any stage fired, `{open:3, late:2, breached:2, unheld:0}` after), and each row carried `% of the window`, the stage, and the named holder with their state. `POST /v1/assignments` refused a non-reader with 404 and a missing reason with 422, then assigned the MRI to the chest reader as 201 with `warning: "Dr Chest does not list sub-specialty mr-spine or modality MR"`, refused the duplicate as 409 `already_assigned`, and the board then named him as the holder |
| Audit chain written by **two processes** | The api writes human rows and the worker writes system rows into one chain. `verify-audit` on the finished run: `audit rows=125 broken=0`. It did **not** verify at first — `hash mismatch at id=46`, the worker's first escalation row, because a `Date` in an audit detail hashed as `{}` and read back as a string. Fixed in `canonicalise`, with a test that hashes the write-time object and the read-back row to the same value |
| Console "Waiting" card | Built and **seen in the browser** as the owner: two overdue rows painted breached (`overdue by 7 min`, `499% of the window · stage 3`, `Dr Chest — accepted`) under the late table, and the "Cannot route automatically" section naming `study 10 · stage 0 · nearest: Dr Chest (queue_full)`. Header counts matched `/v1/panel` exactly (`0 routable, 2 not routable, 1 off`). Layout has not been reviewed as an image — this browser gives no viewport, and its hidden-tab timer throttling means a scripted check must press Refresh rather than trust the poll |

Nothing in this repository has processed a patient study. The studies it has
processed were invented by `scripts/validation/send-test-study.py`.
