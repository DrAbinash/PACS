# telrad

Multi-center tele-radiology service: diagnostic centers push studies in, cases
distribute to contracted radiologists reading from anywhere, reports come back
signed by two names and are billed per center.

**Status: P1 channels proven; the panel routes, the clock escalates, a reader can open the
case they accepted and sign a report for it, and the center gets an invoice.** A study can arrive by C-STORE or by an upload
batch from a center's agent token, be attributed to its tenant, linked to its order, and carry
an SLA clock; a study that matches nothing waits in the orphan queue where a person can link
it. The console shows which readers are routable right now, and the dispatcher offers a case
**only** to a green reader whose profile covers it — accept it, decline it with a reason, or
let the offer lapse and rotate. When a clock starts running out, its stages fire: the pool
widens onto a reader who is present and full and onto nobody else, the late board names the
case and whoever holds it, and an operator can put it on a named reader by hand with a reason
that gets audited. The reader who holds a case can open it: the api re-checks that the case is
theirs and that the pixels live on the node the study says they live on, then ships the raw
16-bit values and the browser does the windowing — because the image node in this deployment
provably cannot window, and cannot serve DICOMweb as configured. A report is drafted against
those images, cannot be signed while Findings or Impression is blank, cannot be countersigned
by the name that signed it, and once signed cannot be edited at all: a correction is a new
version that supersedes the old one, keeping both names and both timestamps. Signing stops the
SLA clock and frees the reader's queue slot. A signed, cleared report is a document: the desk
releases it, the PDF renders deterministically and its SHA-256 is recorded beside the delivery
row, and the report reaches `delivered`. A critical finding is a second gate on that release —
the reader declares it from a closed list and names who they telephoned, and the report cannot
go to the clinic until somebody at the referring end is recorded as having answered it, with the
worker stamping a breach when nobody does. Delivered studies are priced at the tariff in force
on the day the report was delivered, one line per study however many versions were delivered,
and the invoice is numbered in an unbroken financial-year sequence per tenant. A study with no
tariff is named as unpriced rather than quietly dropped. Night readings carry a premium, and
the description says so plainly. The operator's billing panel shows the preview, the draft, the
issued invoices, and the CSV export.
There is still nothing pages a person when a case cannot be routed and nothing phones
the clinic when a finding is critical — "alert" today means an audit row and the board, and the
acknowledgement loop records a call rather than making one. No message is sent to a referring
clinic that has no login. The viewer is a grayscale
image with window and level, **not** a diagnostic viewer: no hanging protocols, no MPR, no
measurement or annotation tools, no cine, and no layout beyond one series at a time.
Nothing in here has received a patient study. The inventory at the end of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the honest state.

Standalone product. It is not a CARE ERP module, it does not call the FutureKind
gateway, and it keeps its own patients, tenants, reports and money. The borrowed thing is
deployment technique — Orthanc + OHIF + Synology Docker, the way `care-pacs` already runs
it, minus that repository's anonymous Orthanc — with one divergence that was measured
rather than chosen: `infra/orthanc/orthanc.json` asks for DICOMweb but the pinned image
answers `/plugins` with three names and leaves the DICOMweb `.so` among the 33 sitting
unloaded in `plugins-available/`, so OHIF cannot be pointed at this node yet and the first
viewer lives in this repo.

## Four surfaces

| Surface | User | Content |
| --- | --- | --- |
| Ingest edge | center's modality or uploader | Orthanc C-STORE, and `apps/agent` — a binary the site runs on its own PC that watches the export folder, batches one folder per study, uploads each instance with its sha256, seals, resumes after a break and never deletes the source |
| Worklist | radiologist | offers with a padlock, accept or decline-with-a-reason, lapse countdown; open the case you hold and window it — no auto-next yet |
| Report desk | radiologist, reviewer | draft → sign → countersign → **deliver**: the signed report renders to a PDF whose SHA-256 is recorded, downloads as `telrad-<accession>-v<n>.pdf`, and moves the report to `delivered`. An amendment supersedes the version instead of editing it. The reader declares a critical finding here from a closed list and names who they told; the report cannot be released while that answer is outstanding. Release also queues a notice to the email address on the referral, which a worker sends with retries and backoff — the message carries the accession, the version and a portal link, never the findings or the patient's name |
| Console | owner, center desk, center admin | who is routable, what is running out and who holds it, what cannot be routed and why, manual assign, what is signed and not yet released with the reason, **which critical findings are still unanswered and by how much**, and the same viewer for a case inside their own scope; **billing — tariffs, preview, draft, issue, CSV export**; rosters and QC are still to come |

## Layout

    apps/api        Express + Drizzle, the only writer of clinical state
    apps/worker     ingest poller, inbox drain, study classifier, SLA clock, escalation,
                    critical-finding clocks, notification queue
    apps/agent      the site's upload agent: watch folder → batch → sha256 → seal → resume
    apps/web        one SPA: on-panel board, reader worklist, the viewer, the report desk,
                    the critical-loop board and the unsent-notice board
    packages/db     schema, migrations, connection
    packages/shared domain enums and pure logic, no I/O
    infra/          orthanc config, caddy config
    scripts/        doctor and validation entry points
    docs/           ARCHITECTURE.md — decisions, measured traps, honest inventory

## First boot

[README-FIRST-DEPLOY.md](README-FIRST-DEPLOY.md) is the path, in the order an
operator can verify each step. Do not improvise from this file.

## Four rules that are not style preferences

- A study's location is a `storage_node_id`, never a hostname in a row. The whole
  NAS-to-cloud move depends on this. See docs/ARCHITECTURE.md.
- No native-compiled dependencies in the server path. Sessions, password hashing
  and tokens use `node:crypto`, so a Linux CI run and a Windows laptop resolve the
  same tree.
- A study that cannot be matched to a tenant and an order goes to the orphan
  bucket and stays unassignable. No signed report on a fuzzy match.
- A critical finding is not communicated when the reader writes it down; it is
  communicated when a named clinician at the referring end is recorded as having
  answered. The report stays undelivered until then, and the clock on that
  answer is separate from the clock on the report.
