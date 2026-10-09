# telrad

Multi-center tele-radiology service: diagnostic centers push studies in, cases
distribute to contracted radiologists reading from anywhere, reports come back
signed by two names and are billed per center.

**Status: P1 channels proven; the panel routes, the clock escalates, and a reader can
open the case they accepted.** A study can arrive by C-STORE or by an upload batch from a
center's agent token, be attributed to its tenant, linked to its order, and carry an SLA
clock; a study that matches nothing waits in the orphan queue where a person can link it.
The console shows which readers are routable right now, and the dispatcher offers a case
**only** to a green reader whose profile covers it — accept it, decline it with a reason,
or let the offer lapse and rotate. When a clock starts running out, its stages fire: the
pool widens onto a reader who is present and full and onto nobody else, the late board
names the case and whoever holds it, and an operator can put it on a named reader by hand
with a reason that gets audited. The reader who holds a case can open it: the api re-checks
that the case is theirs and that the pixels live on the node the study says they live on,
then ships the raw 16-bit values and the browser does the windowing — because the image
node in this deployment provably cannot window, and cannot serve DICOMweb as configured.
There is still no report and no money, and nothing pages a person when a case cannot be
routed — "alert" today means an audit row and the board. The viewer is a grayscale image
with window and level, **not** a diagnostic viewer: no hanging protocols, no MPR, no
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
| Ingest edge | center's modality or uploader | Orthanc C-STORE, watched folders, browser upload |
| Worklist | radiologist | offers with a padlock, accept or decline-with-a-reason, lapse countdown; open the case you hold and window it — no auto-next yet |
| Report desk | radiologist, reviewer | draft → sign → countersign → deliver → amend — **not built** |
| Console | owner, center admin | who is routable, what is running out and who holds it, what cannot be routed and why, manual assign, and the same viewer for a case inside their own scope; tenants, tariffs, rosters, QC, invoices, payouts are still to come |

## Layout

    apps/api        Express + Drizzle, the only writer of clinical state
    apps/worker     ingest poller, inbox drain, study classifier, SLA clock, escalation
    apps/web        one SPA: on-panel board, reader worklist, the viewer; reporting later
    packages/db     schema, migrations, connection
    packages/shared domain enums and pure logic, no I/O
    infra/          orthanc config, caddy config
    scripts/        doctor and validation entry points
    docs/           ARCHITECTURE.md — decisions, measured traps, honest inventory

## First boot

[README-FIRST-DEPLOY.md](README-FIRST-DEPLOY.md) is the path, in the order an
operator can verify each step. Do not improvise from this file.

## Three rules that are not style preferences

- A study's location is a `storage_node_id`, never a hostname in a row. The whole
  NAS-to-cloud move depends on this. See docs/ARCHITECTURE.md.
- No native-compiled dependencies in the server path. Sessions, password hashing
  and tokens use `node:crypto`, so a Linux CI run and a Windows laptop resolve the
  same tree.
- A study that cannot be matched to a tenant and an order goes to the orphan
  bucket and stays unassignable. No signed report on a fuzzy match.
