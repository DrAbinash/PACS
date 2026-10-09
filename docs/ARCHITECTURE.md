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
- `apps/api` is the only writer of clinical state. The worker writes ingest rows
  and nothing else; the future console reads.
- **Green means "will pick this up now", never "has an account".** Presence is a
  heartbeat the open console tab sends every twenty seconds, the state the reader
  declared, and whether their queue has a free slot — all three, computed by one pure
  function (`packages/shared/src/presence.ts`) that the board and the future
  dispatcher both call, so they cannot disagree about who is routable. A tab left open
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
- **Nothing escalates a case nobody took.** `escalation_rules` and
  `sla_clocks.escalation_stage` exist, `bootstrap` seeds three stages (widen_pool at
  55 %, alert_ops at 75 %, manual_assign at 92 %), and no code reads them. A study whose
  only eligible reader has already been asked stays in `/v1/dispatch/unassigned` with
  `already_offered` as its explanation forever. That is the honest current behaviour —
  the alternative is a timer that pages somebody on a rule nobody has agreed yet.
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
- **Priority on the automatic path is inferred, not ordered.** `classifyStudy` reads
  STAT/URGENT out of DICOM text and the matched order's own `priority` is never
  consulted, so an urgent order delivered by a center that writes no priority text is
  clocked as routine — while the *manual* link to that same order clocks it urgent.
  The two paths disagree today. Decide which one wins before the escalation engine is
  built on top of either; the candidate-order query does not even select the column.
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
| `packages/shared` match + classify + two-signature rules + audit chain | Built, 28 assertions passing. Region codes derive from (modality, region); obstetric is tested before abdomen on purpose |
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
| Routing rule (`packages/shared/src/dispatch.ts`) | Built, 21 assertions: colour, tenant reach, coverage (empty = nothing, `*` = everything), night window against the tenant's own zone, capacity, and rotation past readers already asked. Ties break on fewest open cases, then roster, then whoever waited longest. `readerPresence` is the same function the board calls, so a reader the board paints amber is not offered work |
| `apps/worker` dispatch sweep + offer expiry | **Proven live** with three studies on the real upload channel and five seeded readers: the STAT head CT went to Dr Green, the routine head CT to Dr Second *in the same tick* (Green was already holding one, and the sweep counts the offers it has just made), the chest to Dr Chest whom nobody else covers; Dr Paused (amber) and Dr Gone (declared `receiving`, no heartbeat for three hours) received nothing. A lapsed offer was withdrawn and rotated to Green as `attempt_no = 2` |
| `apps/api` accept / decline / my-work / unassigned | **Proven live over HTTP and in the browser**: accept returned a one-time lock token, wrote `assignments.accepted_at` *and* `sla_clocks.accepted_at`; a second accept got 409 `not_offered`; another reader's assignment answered 404, not 403; decline without a reason got 422 and with one released the case. `GET /v1/dispatch/unassigned` named the real gap on the declined chest study: `Dr Chest — already_offered`. Dr Second accepted through the console's own Accept button and the row moved to `accepted` |
| Reader provisioning (`cli add-reader`) | Built and used by the verification. Requires coverage lists, and refuses a stray argument: an unquoted `--name Dr Second` used to create an account called "Dr", which then won the alphabetical tie-break for the STAT case. Real routing bug, found through a real CLI trap |
| Console worklist for the reader | Built and **seen in the browser**: "Your cases" renders the live offer with Accept and Decline, a per-second countdown to the lapse, and the patient/modality/accession line; Accept was clicked and the database row confirmed `accepted` with a lock token. Layout has not been reviewed as an image — this browser gives no viewport |
| Viewer, escalation execution, reports, delivery, billing | **Not built.** The dispatcher routes, the reader accepts, and there is no image viewer to read the case in yet; nothing pages a person when a case cannot be routed |

Nothing in this repository has processed a patient study. The studies it has
processed were invented by `scripts/validation/send-test-study.py`.
