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
- **A signed report cannot be edited, and `amend` is the only way to change one.** The old
  row keeps its text, both names and both timestamps and only changes state; a new version
  starts as a draft **carrying the words it corrects**, because an amendment that opens on a
  blank page loses the findings it was written against. One function decides which row a
  study answers with (`currentVersion`, highest version that is not `amended`/`withdrawn`)
  and it is called by the desk, the routes and the pixel authorisation, so three screens
  cannot point at three different versions of one study.
- **The second name is a rule in two places, and both are needed.** A `CHECK`
  (`reports_not_self_review`) makes it impossible for one id to sign and clear the same
  report — which is the right thing, because a defect in application code would otherwise be
  silent — and the shared function `countersignDecision` refuses it *before* the insert, with
  a reason the reader can read. A constraint violation arrives as a 500 and answers nothing.
  The grade rules (`reviewerMayClear`, `mayAmend`) live beside it: clearing needs a grade at
  least the author's, amending needs one **strictly above**, because a self-correction is
  indistinguishable from an unreviewed edit once both are in one table.
- **Signing stops the clock and frees the queue in the same request.** It writes
  `sla_clocks.signed_at` (the one column `dueStages` refuses to fire past) and moves the
  reader's assignment to `completed`. Left `accepted`, the case would keep counting against
  `max_queue_size` after the report was signed and that reader would quietly stop receiving
  work while the board painted them at capacity — the same failure mode as a declined case
  that is never asked again, arrived at from the other direction.
- **Lateness is frozen at the signature.** `isBreached` compares `signed_at` to the deadline,
  not `now` to the deadline. The report flow found the old form by pushing an already-signed
  clock's deadline into the past: the sweep stamped `breached = true` and wrote an
  `sla.breached` row for a report that had been answered inside its window. A deadline that
  moves afterwards — an orphan relinked, a contract renegotiated, a verification script —
  must not rewrite history, and this is the number a center's QC is measured on. The board and
  the worker both call the one function, so the fix is one function.
- **Three doors open the pixels, and only one of them is a desk.** A reader who holds the case,
  a reader whose *own* report is on it, and a reader a signed report is waiting on. The last
  two exist because one live lock per study is a routing rule: a reviewer is never assigned
  the case they are clearing, and an author loses the case from their desk at the moment they
  sign it. Without those branches the console would contain a report nobody in it can re-read
  against the images it describes.
- **Reading a report is wider than reading its pixels, and the reason is the same reviewer.**
  Non-authors may read the published states — `signed`, `verified`, `delivered`, `amended` —
  and never a draft, whoever they are: a half-written impression reaching a colleague or the
  referring clinic is how "question of perforation" gets read as a diagnosis. The rule is
  `mayReadReport` in `@telrad/shared` rather than an `if` in the route, because it is testable
  without a database and because a role nobody thought about (`typist`, desk staff) should get
  the conservative answer by falling through, not by being named.
- **There is no autosave, and the audit row says what changed.** Saving is a button. The
  audit detail carries the section names and each one's length, because the question after a
  dispute is what the document said, and a hash of a jsonb blob does not answer it. A draft
  that rewrote itself on every keystroke would make the sentence "this is what they signed"
  unanswerable.
- **`dispatch-once` was a mode of `main.ts` and not a package script, so every documented way
  of running the sweep failed.** Three validation scripts and the deploy notes told an operator
  to run `pnpm --filter @telrad/worker dispatch-once`, which answers "None of the selected
  packages has a script" — a first deploy could be routed at all only by guessing the `tsx`
  invocation. It is a real script now, so the documented command is the working command.
- **Delivery is a desk act, and it is where `requires_reviewer` stops being a caption.**
  `deliverDecision` refuses anything unsigned and refuses a report whose sub-specialty needs a
  second name until one is named, so `sub_specialties.requires_reviewer` now blocks a real
  action rather than colouring a badge. Radiologists are not in `DESK_ROLES`: the person under
  time pressure to finish a case is not the person who decides the document leaves, and the
  reader who signed it gets 403 `forbidden` on `/deliver` while the desk gets 200. The reason a
  row cannot go is carried on the row (`reason`, `needsSecondName`) and rendered, because a
  board that silently omits a stuck report teaches the center that nothing is stuck.
- **A critical finding is not communicated until a named person at the referring end says they
  heard it, and until they do the document does not leave.** `critical_events` records both
  halves — `notified_at` (the reader saying they told somebody) and `acknowledged_at` (somebody
  saying they heard) — and `deliverDecision` refuses with `critical_unacknowledged` while any
  loop on that study is open. Releasing into a portal is the slow channel, and a report carrying
  an unanswered pneumothorax that quietly lands there is the failure this product exists to
  prevent. The gate counts by study, not by report version, because an amendment produces a new
  row and a finding nobody has answered does not become answered when the document describing it
  is corrected.
- **The condition list is closed, and the finding is written down by the reader.** Matching the
  impression text against a keyword list was the tempting build and it was rejected twice over:
  a confident false alarm at 2 a.m. trains the referring clinician to ignore the next one, and a
  missed one is the patient. So `CRITICAL_CONDITIONS` in `packages/shared/src/criticals.ts` is a
  fixed catalogue of seventeen codes with the acknowledgement window each one promises, served
  by `GET /v1/criticals/catalogue` so the minute figure on the screen is the one the server
  enforces, and `other` requires the reader's own words. `sla_minutes` is snapshotted onto the
  row at declaration: if a window is renegotiated next year, last night's row still answers the
  number it promised.
- **Declaring is a reader act and acknowledging is a desk act, and neither can do the other's
  job.** A reader may declare only if they hold the case or wrote the *live* version of its
  report — a reader whose version was superseded no longer owns what the study says. Acknowledging
  is restricted to `DESK_ROLES`, and the guard against self-closure is that rule rather than a
  column: a reader who could record their own answer could release a report they had phoned about
  but never reached. Two desks answering the same phone call is normal, so the update is
  conditional on `acknowledged_at is null` and the *first* answer is the one the window is
  measured against; a second one is refused with `already_acknowledged`.
- **The clock is the server's, and a late answer stays late.** `notified_at` is stamped at
  insert and never accepted from the caller, because a service that can backdate a notification
  can turn last night's breach into this morning's compliance. `criticalSweepOnce` then settles
  rows on their own deadlines — including rows already acknowledged *after* their window, which
  is why the sweep's query asks for them: reading only open loops would let the very
  acknowledgement that arrived too late erase the breach it arrived too late to prevent. The
  board still shows `breached` beside a closed loop, and `minutesFromNotifyToAck`, `late` and
  `breachedAtDeclaration` are all in the acknowledgement's audit row.
- **The delivery PDF prints who was told and whether they answered.** Every string on that block
  comes from stored columns, so it costs nothing in determinism: the live run re-downloaded a
  report delivered with two findings and got `6b2578da…`, byte-identical to the recorded hash.
  An open loop prints `acknowledgement NOT YET RECEIVED (was due …)`.
- **A notice is queued by the release and sent by somebody else.** Pressing Deliver inserts a
  `report_deliveries` row with `channel='email', status='pending'` and returns; the worker drains
  it. A desk action that waited on a mail relay would fail in the relay's failure modes — nine
  seconds of SMTP latency, a greylisting, a down relay — and the clinic would get no answer about
  a report that had, in fact, been signed and released. The split also means the queue survives
  the thing that actually kills a NAS deployment: a network that comes back at 4 a.m.
- **The message cannot contain a patient identifier, and the type is why.**
  `ReportReadyMessage` in `packages/shared/src/notify.ts` has fields for the centre, the tenant
  code, the accession, the version, the signature time and the portal link — and no field for a
  name, an MRN, a date of birth or any report text, so the only way to leak one is to change the
  type knowingly. `containsNoPatientIdentifiers` then runs in the sweep over the assembled
  subject and body against the patient's actual name and MRN read from the study, and a message
  that fails is marked `dead` with `patient_identifier_in_body` and **never retried**: a leak
  retried five times is five leaks. The audit row records the refusal without repeating the name
  it just refused.
- **A notice states how many names are on the document, so it has to read the document.**
  `reportReadyBody` prints `This report carries two signatures` — a claim about a released clinical
  record, made before the clinic has opened the portal. The first version of it sourced that
  sentence from `sub_specialties.requires_reviewer`, which is the rule that *demands* a second
  name, not the fact that one exists. The notify phase then separated the two on purpose: the rule
  was switched off to release a version with no countersignature, and the notice for that version
  told the referring clinic it carried two signatures. The queue query now selects
  `reports.reviewer_user_id`, the shared message field is `hasSecondSignature`, and the live run
  reads each version's body back out of the mail sink (`/api/v1/message/<id>` — the plural list
  endpoint carries envelopes only) and asserts the sentence against
  `reviewer_user_id is not null` for that row.
- **`dead` is a state a person has to be shown.** After `MAX_NOTIFY_ATTEMPTS` the row stops being
  queue work and becomes a finding: `notify.dead` in the chain and a row on
  `GET /v1/reports/outbox`, which lists everything not yet sent and counts the given-up ones
  separately. A queue that quietly stops trying is worse than no queue, because the release was
  recorded and the clinic was never told, and nothing on any board says otherwise. The backoff
  ladder (1, 5, 30, 120, 480 minutes) exists so a relay that is down for an hour is not hit forty
  times by one evening's reports.
- **A deployment with no relay keeps its queue.** An unconfigured transport is not an empty
  queue: the sweep returns `skipped` and writes nothing, because marking rows `dead` because this
  box has no SMTP would destroy the record of which clinics were never told — and the operator
  who later configures a relay would have nothing left to send. The worker's boot line says which
  state it came up in, and `TR_SMTP_URL` without `TR_PUBLIC_URL` is refused at the sweep rather
  than sent, because a notice whose only actionable line is a relative link is a letter with no
  address on it.
- **One notice per released version, by key rather than by hope.** The email row carries
  `report:<reportId>:v<version>:email`, the same idempotency scheme as the portal row, so an
  amendment produces a second notice about a different document instead of being swallowed by the
  row that already went out — and a desk that clicks Deliver twice gets one queue item.
- **Delivering is not the same as telling, and the screen says both.** `report.delivery.outbox`
  carries every channel this version was released on with its status, attempts and next try, and
  the board distinguishes `notice sent to …` from `notice DEAD — … (reason)`. The honest limit is
  in the wording: `sent` means a relay accepted the message, not that a human read it. The portal
  row is written as `sent` at the moment of release because the document *is* then available; the
  email row is what remains genuinely asynchronous.
- **The delivered PDF is a pure function of what was signed, and its hash is the claim.**
  pdf-lib, not a headless browser and not a native binding: pure JavaScript, nothing to compile
  on the NAS, and the same bytes from the same row in any container. The creation date is pinned
  to the signature and object streams are switched off so the file is reproducible; `ah()`'s
  sibling in `test/report-pdf.test.ts` measures it (two renders, one hash; different findings,
  different hash). This produced the phase's real defect: the first version printed
  `Delivered <timestamp>` on the page, so the act of delivering rewrote the document whose hash
  had just been recorded, and a clinic downloading afterwards got bytes the audit did not vouch
  for — the live run caught it as `aef3e83e… vs 667f0e5c…`. Nothing operational is printed now;
  when the desk pressed the button is a fact for `report_deliveries` and the audit chain. What
  *does* change the bytes deliberately is the superseded banner, and the download audit records
  both hashes plus `matchesRecord`, so the drift is written down instead of being a surprise.
- **A filename is a leak before it is a convenience.** `telrad-<accession>-v<n>.pdf`, sanitised
  and capped, never the patient's name: these files are downloaded onto reception machines and
  forwarded by hand, and a filename is indexed by everything between the clinic and a court.
- **Helvetica is a WinAnsi font, and a name it cannot draw must not fail the download.**
  pdf-lib throws on an unencodable code point, which in a download route means a signed report
  that the clinic cannot open because of the script a name was written in. `printable()` replaces
  what the font cannot draw with `?`, so the page still prints the patient line and somebody
  complains about the question marks rather than about the service. The honest fix is embedding a
  Unicode TTF through fontkit; that is an open item, not a secret.
- **A comment that says "declare this earlier" is not a guard.** The reports router answered
  400 `bad_id` for `/v1/reports/awaiting-delivery` in the live run because `:id` was registered
  first — the same class as the `awaiting-review` defect the file's own comment describes. The
  comment is still there, and behind it `shadowedRoutes()` in `test/route-boundary.test.ts` now
  walks every route registration in `apps/api/src` and fails when a literal path sits at the
  same depth under the same parent as a parameter path declared before it. The guard test
  includes the broken ordering as a fixture, because a guard that cannot fail is decoration.
- **The desk that releases a report can read it.** `authorize()` in the viewer had three doors
  (holder, author, prospective reviewer) and fell through to "operator, images only, no report",
  which made the delivery board a list of rows you could act on but not open. A platform or desk
  role now gets `reportAccess` with `as: 'read'` when `mayReadReport` allows it — the same rule
  the report routes use, so a center desk account is never handed somebody's half-written draft
  through the back door of the viewer.
- **A failed query is a 500, and the process that answered it stays up.** Express 4 does not
  await a route handler, so a rejected promise from one is not an HTTP error: it is an
  `unhandledRejection`, whose default action in Node is to terminate the process. This happened
  three times in code written for this repository — a `Date` interpolated into a raw `sql`
  template reaches postgres.js untyped and throws while encoding the parameter — and each time
  the visible failure was not the bad query but the api vanishing, `restart: unless-stopped`
  hiding it as a blip, and every connected reader's in-flight request dying with it. `ah()` in
  `apps/api/src/handler.ts` forwards a rejection (or a synchronous throw) to `next`, and
  `errorHandler` mounted last turns it into `{"ok":false,"error":"internal_error"}` with no
  message from the exception in it. All 49 registrations are wrapped — 40 in the eight routers,
  7 in `app.ts`, and the two session guards, which reject on the same database. The boundary is
  enforced twice over: `test/route-boundary.test.ts` scans the source and fails if a new route
  hands Express a bare `async` handler, and it measures the failure it prevents by running the
  same handler unwrapped in a child process (no error middleware reached, no response, non-zero
  exit). `scripts/validation/run-fault-injection.sh` then does it against a real database that
  is stopped and started again: 13 checks, one process throughout, `{"ok":false,…}` while the
  database is gone, and 200 again after it returns without anyone restarting the api. A response
  that had already begun streaming is the one case `errorHandler` cannot answer twice — it hands
  the error back to Express and the socket is torn down, so a truncated report is a broken
  request rather than a half-trusted one. **Any new raw `sql` fragment that takes a timestamp
  must still bind `date.toISOString()` with an explicit `::timestamptz` cast** — the boundary
  makes that mistake survivable, not correct.

## Known open items, stated rather than implied

- **The image node in this deployment cannot serve a real viewer, and the config says it
  can.** `infra/orthanc/orthanc.json` contains a `DicomWeb` block with `Enable: true`, but
  `/plugins` on the pinned container answers `["explorer.js", "gdcm", "orthanc-explorer-2"]`
  — the DICOMweb plugin is one of **33 `.so` files sitting in `/usr/share/orthanc/plugins-available/`**
  and only two are in `plugins/`. The config is therefore inert, `/dicom-web/` is not a
  route, and OHIF cannot be pointed at this node until the plugin is actually loaded and
  the result re-measured. That is a deployment step nobody has taken, and the section in
  the config file predates knowing it.
- ~~**The viewer ships text-shaped pixels, and that has a price.**~~ **Closed.** The frame
  endpoint now fetches `image-int16` (a compressed 16-bit PNG, ~2 KB for a 512×512 slice)
  instead of `matlab` text (~1.1 MB) — a 500× reduction in the Orthanc→API transfer. The
  API decodes the PNG with a minimal pure-JS decoder in `packages/shared/src/png.ts` that
  handles all five PNG filter types for 16-bit grayscale, and ships the raw int16 bytes to
  the browser as before. The browser code is unchanged.
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

- **The delivered document is regenerated, not stored.** `reports.pdf_sha256` is the hash of what
  the renderer produces from the row, and the row is immutable after signing, so it matches —
  today. Nothing keeps the bytes, so a change to the renderer (a layout fix, a new banner, a
  font) would silently re-issue a clinic's report under a different hash, and the only evidence
  would be `matchesRecord: false` in a later download audit. Storing the rendered PDF (and a
  second hash column for the stored copy) is the fix, and it needs a place to put bytes that is
  not a jsonb column.
- **A report waiting for a second name is visible, watched, and keyed to the rule the delivery
  gate enforces.** The desk board lists it with the reason and delivery refuses until it is
  cleared, which is the enforcement the column lacked. The contract clock still stops at
  `signed_at` (right: the center was answered on time), but the worker's review sweep tells the
  operator when a signed report has sat uncountersigned past two hours — one audit row per
  report per hour, so the chain records how long the operator knew. The sweep asks
  `sub_specialties.requires_reviewer`, the same rule `deliverDecision` asks: on a sub-specialty
  that needs no second name a signed report is deliverable, not stuck, and paging "waiting for
  a reviewer" on it would misread a normal state as a fault. What is still missing is any
  outbound channel — the alert is an audit row and the operator's own attention, not a page.
- **Critical findings are declared, gated and timed — and the system still phones nobody.** The
  loop is real: a reader declares from a closed list, names who they told, the report cannot be
  released until somebody at the referring end is recorded as having answered, and a call nobody
  answers is stamped `breached` by the worker with its own audit row. What is *not* there is any
  outbound channel. The `phone`/`sms`/`whatsapp` entries in the channel list describe a call the
  reader says they made; nothing in this product places it, and `portal` and `email` are records
  of where a finding was left rather than of anybody being reached. The report-ready email that
  now leaves the system is a different message on a different trigger: the critical loop does not
  use it, so a declared finding still depends on a human with a telephone, and the acknowledgement
  the service keeps is an attestation typed by a staff member rather than a verified identity. A
  breach is written to the chain and shown on the board; no pager, no second escalation, no
  different person being told when the first one did not answer.
- **An amendment deliberately does not reopen the clock, and its own turnaround is not
  measured.** The center was answered on time by the first signature, so a correction cannot
  become a breach the dispatcher widens a pool for. The cost: there is no column for the time
  from "amendment requested" to "amendment signed", so if a contract ever prices corrections,
  that number has to be captured at the time rather than derived afterwards from the audit
  trail. **Closed.** The turnaround is now exposed in the API: `GET /v1/reports/:id` returns
  `amendmentTurnaroundMinutes` for amendment rows (computed as `signedAt - createdAt`), and
  `GET /v1/reports/awaiting-review` returns `waitingMinutes` (how long a signed report has
  been waiting for a second name) and `isAmendment` (whether the row is a correction rather
  than a first read). The data was already on the row; surfacing it means a contract that
  prices corrections can read the number without deriving it from two timestamps.
- **Report text is five fixed sections.** Findings and Impression must carry words; clinical
  history, technique and recommendation are optional. No per-sub-specialty templates, no
  dictation, and the `structured` jsonb column exists with nothing writing it. The `typist`
  role is in the enum and no part of the report path uses it.

- **A declined case is never asked again, and widening cannot fix that.** Rotation
  refuses to re-offer a study to a reader who has already been asked, so the chest film
  a reader sends back with a reason stays in `/v1/dispatch/unassigned` with
  `already_offered` as its explanation at every stage, up to and including breach. That
  is deliberate for the automatic path — a case cannot be forced back onto the person who
  just refused it — and the manual assign exists to be the way out. What is missing is
  the other way out: nothing re-offers it after the reader's own queue empties, so a
  decline at 1 a.m. needs a human awake at the board.
- ~~**A widened offer has no ceiling.**~~ **Closed.** `MAX_OVER_CAPACITY = 1` in
  `packages/shared/src/dispatch.ts` caps a widened queue at one over the declared maximum.
  A reader holding three studies against a one-slot declaration is not "busy", they are a
  bottleneck that cannot be seen, and STAT cases do not get a second over because a case
  that cannot wait also cannot wait for a reader who is already past what they said they
  could handle.
- **A router mounted at `/v1` guards paths it does not own.** `r.use(requireAuth)`
  inside such a router runs for *every* `/v1/...` request, so a radiologist polling
  `/v1/presence` was answered 403 by the sites router's owner-only check, and an agent
  token polling `/v1/uploads` was answered 401 by a session guard. Both are fixed by
  `scoped()` in `apps/api/src/auth.ts`, which applies a guard only to the path prefixes
  that router declares. Mount order is no longer load-bearing, but a new router must
  still list its own prefixes — forgetting that reintroduces the bug silently.
- ~~**An unknown `/v1/...` path answers with Express's HTML 404, not JSON.**~~ **Closed.**
  `app.use('/v1/*', ...)` in `apps/api/src/app.ts` answers with `{ ok: false, error: 'not_found' }`
  before the error handler runs. Every other failure mode in this API speaks JSON, and a
  client should not have to special-case one.

- **A study that arrives on the upload channel is attributed by an Orthanc label, and
  Orthanc's label rules are load-bearing.** The write verb is `PUT
  /instances/{id}/labels/{name}` — `POST` to that path answers 405 — and a name may
  only contain `[A-Za-z0-9_-]`, up to 64 characters, or the node answers 400. That is
  why labels are `telrad-batch-<id>` and not `telrad:batch:<id>`, and why
  `apps/worker/src/labels.ts` owns the spelling instead of leaving it to memory. A
  REST-pushed file has no `RemoteAET`, so if the label is ever refused the study lands
  in the orphan queue as `site_unresolved` rather than being guessed at; the instance
  is still recorded as `pushed`, because the bytes really are archived.
- **The agent takes a folder only when a second scan agrees, and it never deletes anything.**
  `apps/agent/src/main.ts` lists the watch root, and a folder is eligible when every file is older
  than `--settle` *and* the same listing appeared on the previous scan with the same names, sizes
  and times (`folderSignature`). Orthanc flips a study to stable about two minutes after the last
  instance, so a scanner that wrote slice 30 forty seconds ago and will write slice 31 in a minute
  is exactly the case a single scan cannot tell from a finished study — and sealing half a study
  sends a radiologist a partial exam. Deleting or moving the source after a send would be the
  simple answer: the export folder is the center's copy until the archive confirms the study, so
  an agent that eats its input turns a failed night into lost patients, and the cursor in
  `telrad-agent-state.json` remembers instead. `--once` trades the second scan for the settle
  window alone, because cron has no next pass to agree with.
- **Identity is name, size and mtime, then content — and a re-send is a decision, not an
  accident.** A file whose three match the cursor is never opened, which is what makes a scan of
  a two-terabyte history cheap enough to run every twenty seconds beside a scanner. A file whose
  mtime moved but whose sha256 did not (a folder copied, a share re-mounted) is hashed once, not
  re-sent, and its record is updated in place. `refused` is the one status that is asked again:
  the server rejected those bytes, and the file on disk may have been rewritten since.
  `quarantined` is finished, not failed — the bytes are on the server and saying they are not an
  image; sending them a fifth time will not make one.
- **A batch left open is resumed by its own id, never re-opened.** If the connection dies halfway
  through a study, the next pass fills the same `upload_batches` row and seals it; two
  half-batches read to the worker as two studies nobody ordered. The failure is recorded per
  folder with a backoff (5, 15, 60, 300, 900 s) so an api that is down for the night is not hit
  every twenty seconds by every modality PC on the network, and a folder with nothing left to send
  is *not* marked failed — that distinction is the difference between a retry and a false alarm.
- **A folder's name is a patient until proven otherwise, so the log prints a digest.** Export
  directories on real modalities are routinely named `KAVITA RAO CT HEAD 20261010`, and the agent
  log is the file somebody attaches to a vendor support email. `redactFolder` is on by default and
  `--log-names` is the deliberate opt-out for the operator debugging their own machine.
- **Batch hints come from an operator-stated template with three tokens, and an unknown one is an
  error.** `--hints "{accession}-{date}"` is applied to the folder's *leaf* name by an anchored,
  shape-aware regex — the date token is eight digits and the accession token is a character class,
  because `{accession}-{date}` against `ACC-4477-20261010` only splits in the right place if the
  engine knows where the date begins; the first version split at the first dash and produced
  `ACC`. There is deliberately no `{patient}`, `{mrn}` or `{name}` token: asking for one throws
  rather than capturing a name into a column the rest of the tenant can read. A value that does
  not validate yields **no** hint rather than a near one, which the live run proved both ways: the
  folder called `ACC-AGT-1` arrived with a hint and linked by accession, and the folder called
  `RAVI KUMAR CT 20261010` arrived with `accession_hint = null` and still linked, because linking
  uses the accession inside the file and a wrong hint would have attached it to the wrong patient.
- **The credential never touches argv, and cleartext is refused.** `--token` raises an error
  because the process list is readable by every other account on a shared workstation and lands in
  shell history; `--token-file` and `TELRAD_AGENT_TOKEN` are the only paths. An `http://` origin is
  refused unless `--allow-insecure-http` is passed, because the site token rides on every request —
  which is why the loopback validation runs say so explicitly rather than by omission.
- **Two defects the agent's own live run caught, both in the tooling.** The first argument parser
  advanced twice for a flag that took a value and once for a boolean, so `--once --dry-run`
  silently dropped `--dry-run` and sent real files in what the operator believed was a rehearsal —
  found on the second flag tried, now a named regression test. And a batch that holds nothing but
  quarantined files was refused with `422 no_dicom_files_received` and left `open` in the database
  forever: a state no sweep picks up and no screen explains, which is where a study hides. It is
  now `rejected`, audited as `upload.batch_rejected`, and the agent's local close and the server's
  row agree.
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
- **`studies.instance_count` was one short on every study, and is the node's number now.** It
  used to be a per-poll increment whose insert branch never seeded the row, so a three-instance
  study was filed as two; measured live on the upload channel against
  `GET /studies/{pk}/statistics` (node 3 and 2, database 2 and 1). Rewinding `ingest_cursors` to
  re-scan still moves `bytes`, which is why the authoritative stamp happens at settle rather than
  on every poll. Nothing quotes these numbers to a center yet — Phase F will be the first.
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
- Retention is now a job. Each tenant carries `retention_days` — edited from the
  console settings card, audited as `retention.policy_set`, `null` keeps images
  forever — and the worker's nightly sweep deletes the pixels of studies older
  than their tenant's policy. It deletes at the node first and marks
  `studies.purged_at` second: a crash mid-purge re-selects the row, the node's
  404 counts as already done, and the row is marked once. The reverse order would
  be the one lie this platform must not tell. Reports, billing and the audit
  chain outlive the images; a pinned study (`studies.pinned_at`) is never swept;
  the viewer answers a purged study with its purge date instead of forwarding the
  request to a node that no longer has it. Still open: no screen shows the queue
  of upcoming purges, and there is no export-before-delete.

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
| `packages/shared` match + classify + two-signature rules + audit chain | Built; the package carries **174 assertions across nine files** (order matching, classify + enums + the audit chain in one, presence, the routing rule, the escalation rule, the report lifecycle, the critical-finding loop, pixel parsing and windowing, request validation). Region codes derive from (modality, region); obstetric is tested before abdomen on purpose |
| `apps/api` health, login/session/logout, tenant-scoped study reads, audit read | Built and **exercised over HTTP**: login issued a session cookie, a wrong password got 401, an unknown `state` param got 400, an unauthenticated read got 401 |
| `apps/api` bootstrap + `verify-audit` | Ran against the test database: owner + tenant + node + catalogs written, audit chain verified `rows=4 broken=0` |
| `apps/api` order and patient entry, site registration, agent tokens, upload batches, orphan queue | Built and **exercised over HTTP** by `scripts/validation/run-p1-flow.py`, which now drives the agent steps with a token and **no cookie jar** — the first version of that script reused the console session and hid a defect that made the whole upload channel unreachable for an agent |
| `apps/worker` inbox → Orthanc for the **upload channel** | **Proven end to end**: agent opened a batch, PUT three instances (one rejected for a bad sha256 before it was stored), sealed; the worker pushed 3/3 and labelled each with the batch id; the poller read the label, attributed tenant 1 / site 1, linked the study by accession at score 1.000, and opened one clock at first-sight + 120 minutes. A zip batch exploded into its three members and labelled them the same way |
| `apps/agent` — the thing a site installs on its own PC | Built, **103 assertions** across four modules: the settle window and its exact boundary, the two-scan `folderSignature` rule (a folder added to, a file rewritten, a listing reordered), folder→batch planning against the server's own file and byte caps with the parts numbered, the cursor round trip — including its refusal to run rather than guess when the file is unreadable or belongs to a different root —, the five retry classes in the HTTP client, and the sweep against a fake server for resume, backoff, quarantine, refusal and dry run. **Proven live in 48 assertions** (`scripts/validation/run-agent-flow.py`, driven by `run-agent-live.sh` from an empty database): real Part-10 files in a real folder, the binary run as a subprocess with a token file. It refuses cleartext and refuses `--token`; `--settle 3600` took nothing and opened no batch; the loop's first scan said `waiting for a second scan` and a later scan opened the batches; six files went in two sealed batches — one per folder — with the `README.txt` somebody left beside the images quarantined rather than dropped; `instance_count` matches the node (3 and 2, `linked=accession`); a second run over the same folders opened nothing and sent nothing; a folder that grew opened one more batch, and deleting the file did not re-open the study it came from; against an api that was not there the run exited 0, opened no batch, scheduled that folder's retry and left every already-sent folder with `failures = 0`; and the agent's own output never printed the patient-named folder it sent |
| `apps/worker` settle stamping the node's counts (`orthanc.studyCounts`) | Built, 3 assertions on a fake port, **measured live as a defect first**: three instances arrived and the study row said two, because the ingest upsert incremented on update and never seeded on insert. `GET /studies/{pk}/statistics` was probed on the pinned 1.13.0 before it was used (`CountInstances`, `CountSeries`, `DicomDiskSize`), the insert now seeds 1, and the authoritative numbers are stamped when the node calls the study finished — with the statistics call wrapped so a node that will not answer still lets the study complete and its clock open, because the count is a fact to record and the clock is a promise to a patient |
| `apps/api` a batch that can never be ingested | Built and **proven live**: `POST /batches/:id/seal` with nothing DICOM in it answers `422 no_dicom_files_received` **and** writes the row to `rejected` with its own `upload.batch_rejected` audit action, because leaving it `open` is the one state in this schema where a study hides — no sweep takes it and no board shows it. After a full agent run, `select count(*) from upload_batches where status='open'` is 0 |
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
| Viewer, reports, delivery, criticals, billing | Billing is **not built**. A released report now queues a notice to the address on the referral and a worker sends it, so a referring clinic with no login is told the report exists — but the send is only proven against a local sink, never a real relay, and no WhatsApp or SMS channel exists. The critical-finding loop **is** built — declared by the reader, gating delivery, timed by the worker — and it records a phone call rather than making one. The viewer draws real pixels with an adjustable window but is not diagnostic-grade; the report lifecycle (draft → sign → countersign → deliver → notify → amend) is built and proven below — see the open items for what is still missing |
| Report lifecycle (`packages/shared/src/report.ts`) | Built, **36 assertions**: which state permits which verb (a signed report is editable by nothing and amendable only by a strictly higher grade), that a newline counts as nothing written in a required section, the three separate countersignature refusals (same person / no grade recorded / grade below the author), `nextVersion`, `currentVersion` answering with the newest live row and never a superseded one, `mayReadReport` keeping a draft from every non-author including a colleague in the same tenant, `deliverDecision` (unsigned, already gone, waiting on the second name, or an unanswered critical finding) with `needsSecondName` beside it — including the ordering, that a cleared second name does not release a report carrying a finding nobody has answered, and both refusals on one row answering the nearer gap first — and `deliveryIdempotencyKey` keyed on the *version* so an amendment is never swallowed by the row that already went out |
| Critical-finding loop (`packages/shared/src/criticals.ts`) | Built, **20 assertions**: the catalogue is closed with no duplicated code and a window on every entry, and the ten-minute findings are ordered against the day-long one because a contract argues about a number rather than inventing one at the desk; `criticalCondition` resolves an unknown or missing code to a visible entry rather than to nothing, since a board that crashes on history cannot be read at 2 a.m.; the six separate declaration refusals (unknown code, no channel, nobody named, a reach-channel with no number, `other` without the words); that `portal` and `email` do **not** require a number, because they record where a finding was left and not that anybody was reached; that a second acknowledgement is refused rather than ignored, since the first one is the number the window is measured against; and the clock — deadline from the notification, `waiting` inside the window including its exact minute, `breached` outside it, `acknowledged` after a late answer but still `late`, and a countdown that goes negative instead of clamping |
| `apps/api` report routes (`/v1/reports`) | **Proven live over HTTP** — `scripts/validation/run-report-flow.py`, **70 assertions** in `--phase check`, 39 in `--phase critical` and 10 in `--phase late-clock-after-sign`, run from an empty database. A reader who does not hold the case cannot start a report (403 `not_your_case`) and cannot open its images; a colleague can read a signed report but gets 404 on somebody else's *draft*; a misspelled section is refused rather than dropped; signing with an empty Impression answers `sections_blank:impression`; the signature block carries the registration number (`WB-100001`), not the screen name; a signed report refuses a PATCH with 409 `signed_report_is_immutable`; signing writes `sla_clocks.signed_at`, moves the assignment to `completed` and the case vanishes from `/v1/my/work`; the author is offered no countersignature of their own; a junior sees the report in the review queue with `mayClear: false, reason: grade_below_author` and is refused the same way when they try; a chief clears it and both registrations are stored on two different user ids; an amendment without a reason is refused, one by the author or by a junior is refused on grade, and the accepted one produces v2 as a draft that **carries v1's text**, supersedes it by id *and* by version number, while v1 keeps both names and both timestamps; `?studyId=` answers with v2; the author and the reviewer can each find their own row in `/v1/reports/mine` |
| `apps/api` criticals (`/v1/criticals`) | **Proven live in the 39 `--phase critical` assertions.** The catalogue is served (seventeen codes, a window on each); no loop exists before somebody declares one; a reader who neither holds the case nor wrote the live version is refused `not_your_case` — measured, not reasoned: the first version of this door accepted *any* version the reader had ever signed, so the author of a superseded v1 declared against somebody else's v2 and the live run caught it as a 201 where a 403 was asserted. All five declaration refusals answer with their own code; a valid phone declaration returns 201 with `state: waiting`, `minutesLeft <= 10` and the report id it was written into; the report then carries the loop, `delivery.openCriticals = 1` and `can.deliver = false`; the desk's delivery attempt is refused `review_required` first and `critical_unacknowledged` only after the sub-specialty's reviewer flag is removed, which is the ordering proved rather than assumed; the board's row names the reason and the open count instead of hiding the button; a reader posting an acknowledgement gets 403 and an unknown loop gets 404; an acknowledgement recorded by the desk closes the loop, `openForStudy` answers 0, `late` is false, a second attempt is refused `already_acknowledged`, and the report then delivers — with the delivered PDF's hash matching the bytes re-downloaded afterwards (`6b2578da…` on the run behind this sentence) and the delivery audit row carrying `acknowledgedByName` |
| `apps/api` delivery (`/deliver`, `/pdf`, `/awaiting-delivery`) | **Proven live in the same 70 assertions** (24 of them delivery), from an empty database through a real ingest. The desk lists a cleared report as waiting and names `Dr Referrer`; a reader gets 403 on the board and on `/deliver`; the PDF arrives as `application/pdf` with `Cache-Control: no-store` and `attachment; filename="telrad-ACC-REP-1-v1.pdf"`; nothing is recorded as delivered before the act, and the desk is told `can.deliver` while the reader holding it is not; delivery writes `state=delivered`, `reports.delivered_at`, `sla_clocks.delivered_at`, `pdf_sha256`, and exactly one `report_deliveries` row `portal\|sent\|report:1:v1:portal\|Dr Referrer`; it goes once (`422 already_delivered`) and then leaves the waiting list; **re-downloading produces the identical hash**; amending the delivered v1 leaves its `delivered_at` and hash intact, names `supersededByVersion: 2`, and the signed v2 is refused with `422 review_required` — with the reason on the desk's row rather than hidden; the re-render of the superseded v1 differs from the delivered record and the audit row records `matchesRecord=false` instead of pretending otherwise |
| Report PDF rendering (`apps/api/src/report-pdf.ts`) | Built, **22 assertions** on the module alone: bytes start `%PDF-`, the returned hash is the hash of the returned bytes, two renders of one report are byte-identical and different findings change them, a 400-line Impression paginates rather than truncating, `verified` and `delivered` of the same report hash the same (the defect above), a Devanagari name renders as `?` rather than throwing, `printable` keeps `— · “ ” µ` and tabs, `wrapText` breaks a token wider than the column, and the drawn lines carry the patient, both registrations, both timestamps, the amendment reason, the `SUPERSEDED by version 2` banner, and both halves of a critical loop — `Told … by phone · acknowledged <when>` for an answered finding with no `NOT YET RECEIVED` anywhere on the page, and `Receiver not recorded · acknowledgement NOT YET RECEIVED (was due …)` for an unanswered one — asserted from the render list, because pdf-lib compresses the content stream and a byte search finds nothing |
| Worker critical sweep (`apps/worker/src/criticals.ts`) | Built, **9 assertions** on a fake port and proven live. An unanswered finding past its own window is stamped and gets exactly one `critical.breached` audit row carrying `minutesPastDeadline`; a loop still inside its window is counted as `waiting` and left alone; **a finding acknowledged late is still stamped**, because the patient waited anyway and a breach that depends on when a sweep happened to wake up is not a measurement; one answered in time is never fetched at all (the port's query excludes it, which is what makes that assertion mean something); a sweep that loses the race to the guarded update writes no audit line; and two findings notified at the same moment with different windows settle on their own deadlines rather than on a global one. Runs on every tick and alone via `pnpm --filter @telrad/worker criticals-once`, which exists because a verification run that also dispatches moves cases onto readers' desks and then proves nothing about the loop it came to look at |
| Notification rules (`packages/shared/src/notify.ts`) | Built, **17 assertions**: the backoff ladder strictly increases and clamps outside the table rather than returning `undefined` (a missing backoff would have to mean "never try again", which is not "retry later"); `mayAttempt` refuses a `sent` row, a `dead` row and one whose next try has not arrived, and allows one whose schedule is null; `afterAttempt` produces `sent` / `failed`+next / `dead` with no next; `normaliseEmail` accepts a real address and refuses the six things that are not one — this is the function that shipped broken, rejecting **every** address because its own test's `/[\s@]/` character class matched the `@` in all of them, which the suite caught before the live run ever ran |
| `apps/worker` notify drain (`apps/worker/src/notify.ts`, `smtp.ts`) | Built, **9 assertions** on a fake port and **proven live in 27 `--phase notify` assertions**: an unconfigured relay sends nothing and writes nothing (`skipped`); a due row is sent once, recorded `sent` with `attempt_no = 1` and audited with the relay's host as `transport`; a body carrying the patient's name or MRN is killed as `dead` with `patient_identifier_in_body` and **never retried**, and its audit row names the recipient without repeating the name; a refused connection comes back `failed=1` with `next_attempt_at` in the future; the fifth attempt ends the row `dead=null=connect ECONNREFUSED 127.0.0.1:1026` with no further try scheduled; a dead row is never handed work again; the signature sentence is read out of the sink against `reports.reviewer_user_id` for **each** version — v1 with a countersignature says `carries two signatures`, v2 released with the reviewer rule switched off says `carries one`, and the first version of this code said two for both because it read the rule; nodemailer behind a port interface, because it is the only pure-JS SMTP client here and the deploy rule forbids a native binding in the server path |
| `apps/api` notice board (`GET /v1/reports/outbox`) | **Proven live**: desk-only (a reader gets 403), lists `pending`/`failed`/`dead` with recipient, attempts, next try, error code and the report each belongs to, counts queued and dead separately, and empties when the queue drains — the card that goes away is the correct ending for a to-do list. `report.delivery.outbox` carries the same rows on the report itself, so "released" and "the clinic was told" are two lines on one screen |
| Throwaway stack and one-command flow (`scripts/validation/run-live-stack.sh`, `run-report-live.sh`) | The five acceptance flows all assumed a migrated database, a bootstrap owner, three graded readers, an Orthanc node and an api on 3101, and none of them said how that came to exist — the recipe was in one operator's head, which makes "proven live" mean "proven once, by whoever remembered the order". `up` builds its own network, containers, ports and fixtures with credentials named as fixtures and `down` removes them; `run-report-live.sh` drives ingest, waits for the node to call the study stable, hearts one reader onto the panel, dispatches, and runs every phase, then asserts `broken=0` on the audit chain. `api-start` kills the listening process first and fails on `EADDRINUSE`, because a backgrounded second api dies while the *old* one answers every probe — measured twice on this machine |
| Routing and escalation stop at a signature | **Measured on the same run.** With the clock pushed to sit between the signature and now, the sweep reported `escalate checked=1 staged=0 breached=0 actions=none`, the late board stayed empty, `count(*)` over `sla.escalated`/`sla.breached` for that accession was 0, and no live assignment survived. The first version of this run did **fail** the last of those: signing completed the assignment, which returned the study to the dispatchable queue and produced a fresh offer (`attempt 2`) for a case two names had already answered. `dispatchableStudies` now refuses any study whose clock carries `signed_at` — the same column `dueStages` stops at — so the operator's "why is this nobody's case" read and the sweep cannot disagree about an answered study |
| Console report desk | Built and **seen in the browser** end to end as two different readers. As Dr Chief: *Start the report* → five fields with Findings and Impression marked required, the status line reading `unsaved words` while typing and `saved` after the button, Sign enabled only when both required fields hold words, and after signing the text renders read-only under `Signed / Dr Chief · WB-400004 / 12:51:46` with `Second name / required, and missing`. As Dr Chief again on somebody else's report: the review queue named the case and their own grade, *Review* opened the images with the bar saying plainly why they were not holding the case, and *Add my second name* moved the panel from `signed` to `verified` and filled the second block. As Dr Junior: the same queue entry refused them with the sentence, and the viewer still opened. The desk now carries a `report signed v2` chip on each case, and "Reports I signed" lists what a reader has already answered — signing takes the case off the desk, so without that list there is no link back to one's own report. As the owner on the **Awaiting delivery** board: the row named `ACC-REP-1 · CT ct-head · Kavita Rao · P-REP-1 · whq`, `v2 · signed · to Dr Referrer`, the line `blocked: this sub-specialty needs a second name` and the badge `awaiting a second name`; *Open* drew the images with the bar `You are opening this as the desk, not as a reader. Version 2 of its report is signed.` and the panel beside them refused a release in words; after a second chief cleared v2 the same row showed a **Deliver** button, and clicking it returned `state=delivered`, a `delivered_at`, a recorded hash, and no board at all — which is the correct ending for a list of things waiting. On the same screen as Dr Second, the author of the live version: the panel's **Critical findings**
block listed both loops, marked the one answered after its window `— after the window`, offered
*Declare a critical finding* (a select carrying all seventeen catalogue entries with their
minutes, and the number-you-rang field appearing only for the channels that reach a person), and
after declaring a cord compression showed `waiting · 30 min before the answer is late` beside
`1 still unanswered`. As the same reader, no acknowledgement control was offered anywhere. As
`ops` on the **Critical loops** board the next moment: the same finding, `ACC-REP-1 · Kavita Rao ·
told Dr P. Menon (Neurology) by phone`, with *Record acknowledgement* — and typing the name and
pressing *Record* removed the row, because a board of open loops that keeps showing closed ones
stops being the list of things to do.
Layout has not been reviewed as an image: this browser gives no viewport |
| `pnpm --filter @telrad/worker dispatch-once` | Was a mode of `main.ts` with no package script, so **every documented way of running the sweep failed** with "None of the selected packages has a script" — three validation scripts and the deploy notes among them. It is a real script now; the verification above ran it as written |
| Async-error boundary on every route (`apps/api/src/handler.ts`) | **Proven live** by `scripts/validation/run-fault-injection.sh`: a throwaway database was stopped under a running API and 13 checks passed — the request answered `500 {"ok":false,"error":"internal_error"}` (nothing from the exception in the body), `/health/live` kept answering from **the same pid**, a second request did the same, `requireAuth` rejecting on the way in behaved identically, and reads returned to 200 when the database came back with no restart in between. 49 registrations wrapped. `test/route-boundary.test.ts` holds the line: it scans `apps/api/src` and fails on a bare `async` handler, and it measures the failure mode in a child process (error middleware never reached, no response, non-zero exit) so the fix is not taken on trust |
| Orthanc capability probe (`.tmp` scripts, now `scripts/validation/probe-*.py`) | Run against the pinned digest before the viewer was designed: plugins loaded, tag endpoints, every rendering endpoint with and without a window, the numeric frame path and its exact text shape. The result is the six viewer rules above, and it overturned three endpoint names this repository's own worker had assumed |
| `apps/api` viewer routes (`/v1/view/:studyId`) | **Proven live over HTTP** (`scripts/validation/run-view-flow.py`, 17 assertions): the holder opens a case and gets its series with instance ids; the frame arrives as 8,192 bytes of `int16-le` with `X-Telrad-Pixel-Count: 4096` and `Cache-Control: no-store`, and **all 4,096 values equal the arithmetic the fixture wrote** (`0 of 4096 differ`); two slices of one study are two different images. Another reader gets 403 `not_your_case`, an instance belonging to somebody else's study gets 404 `not_in_this_study`, no session gets 401, a malformed node id gets 400 before the node is asked, and `frameIndex` out of range gets 400. An operator may open a case they do not hold, and every open writes `view.open` |
| Console viewer | Built and **seen in the browser** as the reader who holds the case: `ACC-VIEW-1` opens full-window with the header, the series strip (`HEAD NATIVE 3`), `slice 1 / 3` and `64×64 · 12-bit · windowed here`. The canvas holds an image, not a rectangle — **217 distinct grey levels, min 0 / max 255, mean 61.2**; ArrowDown moved to slice 2 (222 distinct, mean 58.7); narrowing the window to 60 collapsed it to 45 distinct levels, which is the window doing work on this side of the wire. The chest reader's DX film, which carries **no WindowCenter at all**, drew through the stored-range fallback at 80 distinct levels / mean 52.3 rather than going black. Console shows only the expected 401s from `/v1/auth/session` after a logout |
| Escalation rule (`packages/shared/src/escalation.ts`) | Built, 18 assertions: `elapsedPct` (unclamped above 100, zero-window measured as 100), `rulesFor` (a tenant's rows **replace** the platform's for that priority, they do not merge), `dueStages` (nothing fires on a signed clock, every missed stage returns in one pass), `widenStage`, and `isBreached` measured **against the signature** — a clock signed inside its window is not late however its deadline is rewritten afterwards, and a clock signed after it is |
| `apps/worker` escalation pass | **Proven live on the real clocks.** Crossing 55 % produced `escalate checked=3 staged=2 breached=0 actions=widen_pool:2` and one `sla.escalated` row per clock with `actor_kind = system`; 80 % produced `alert_ops:1`; pushing a case from 65 % straight to 98 % fired **stages 2 and 3 in one pass** with two audit rows, and the deadline pass reported `breached=2`. An immediate second pass reported nothing, and the breach count in `audit_log` is still one row per clock |
| The widened offer, measured | The chest study whose only cover had just filled their one-slot queue was offered anyway (`dispatch widened=1`) and they accepted, taking the queue to **2 of 1**; the manual assign below made it 3 of 1, which is the open item rather than a surprise. The spine MRI whose only full cover was *paused* stayed unheld at the same stage: `poolWidened=true, status=blocked, nearest=Dr Paused (not_routable)`. Dr Green, green and idle for the whole run with the wrong lists, was never offered anything at any stage |
| `apps/api` late board and manual assign | **Proven live over HTTP**: `GET /v1/escalations` listed only clocks with something to say (`{open:3, late:0}` before any stage fired, `{open:3, late:2, breached:2, unheld:0}` after), and each row carried `% of the window`, the stage, and the named holder with their state. `POST /v1/assignments` refused a non-reader with 404 and a missing reason with 422, then assigned the MRI to the chest reader as 201 with `warning: "Dr Chest does not list sub-specialty mr-spine or modality MR"`, refused the duplicate as 409 `already_assigned`, and the board then named him as the holder |
| Audit chain written by **two processes** | The api writes human rows and the worker writes system rows into one chain. `verify-audit` on the finished escalation run: `audit rows=125 broken=0`; on the finished report run: `audit rows=89 broken=0` (the same run with the critical loop driven
through, from `60` before it), with `report.draft_created`, `report.draft_saved` (which fields, and each one's length), `report.signed` (with `late`, measured against the clock at that moment), `report.countersigned`, `report.amended` (supersedes id, from-version, to-version, the reason and both grades), `report.delivered` (channel, recipient, the PDF's hash, its byte count, page count and every critical loop on the study with who acknowledged it), `report.pdf_downloaded` (rendered hash, the recorded hash and whether they match), `report.delivery_queue` (split into the rows blocked for a second name and the rows blocked for an unanswered finding), `report.read`, `view.open`, `critical.declared`, `critical.acknowledged` (`minutesFromNotifyToAck`, `late`, `breachedAtDeclaration`) and `critical.breached` all in it. It did **not** verify at first — `hash mismatch at id=46`, the worker's first escalation row, because a `Date` in an audit detail hashed as `{}` and read back as a string. Fixed in `canonicalise`, with a test that hashes the write-time object and the read-back row to the same value |
| Console "Waiting" card | Built and **seen in the browser** as the owner: two overdue rows painted breached (`overdue by 7 min`, `499% of the window · stage 3`, `Dr Chest — accepted`) under the late table, and the "Cannot route automatically" section naming `study 10 · stage 0 · nearest: Dr Chest (queue_full)`. Header counts matched `/v1/panel` exactly (`0 routable, 2 not routable, 1 off`). Layout has not been reviewed as an image — this browser gives no viewport, and its hidden-tab timer throttling means a scripted check must press Refresh rather than trust the poll |
| Billing: tariffs, invoices, and the money path (`packages/shared/src/money.ts`, `apps/api/src/routes/billing.ts`) | **Proven live over HTTP** — `scripts/validation/run-billing-flow.py`, **5 phases** from an empty database. A tariff is a row with a modality, a sub-specialty, a window, and a rate; the rate in force on the day the report was *delivered* prices the study, so a tariff retired in November still prices an October study correctly. One line per study however many versions were delivered — a center that was answered, then corrected, was still answered about one patient, and an amendment that adds a second charge is the kind of invoice dispute that ends a relationship. The correction itself is free, which is the clinical incentive. A study with no tariff is named as unpriced rather than quietly dropped or priced from a neighbouring modality. The invoice total is re-added from its own lines at the moment of issue, so the number on the page is provably the sum of the rows above it. Numbers are integer paise only — no floating point anywhere in the money path, because a center's accounts desk adds up the rows by hand and a rounding difference is the kind of thing that ends a contract. Night readings carry a premium (a multiplier on the base rate), and the description says so plainly — `CT ct-head report — night reading for ACC-1` — because the center needs to see why the number is higher. The financial year runs April–March, and invoice numbers are a sequence starting at 1 per tenant per year; a dropped draft costs no number, and the next draft in the same period takes the same number the dropped one would have had. `GET /v1/billing/invoices` lists with line counts via LEFT JOIN + GROUP BY (a correlated subquery in Drizzle's `sql` template binds parameters, not columns, so the subquery returned the same count for every row — measured, not assumed). `POST /v1/billing/invoices` creates a draft from a period; `POST /v1/billing/invoices/:id/issue` stamps `issuedAt` and writes the audit row; `DELETE /v1/billing/invoices/:id` drops an unissued draft. `GET /v1/billing/invoices/:id/export.csv` produces a CSV with the accession, the description, the tariff, the quantity, the unit price, the night flag, and the amount — the one document that leaves the platform and lands on a center's accounts desk. The operator's billing panel in the console shows the preview, the draft, the issued invoices, and the CSV download link |

Nothing in this repository has processed a patient study. The studies it has
processed were invented by `scripts/validation/send-test-study.py`.
