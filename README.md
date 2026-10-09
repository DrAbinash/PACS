# telrad

Multi-center tele-radiology service: diagnostic centers push studies in, cases
distribute to contracted radiologists reading from anywhere, reports come back
signed by two names and are billed per center.

**Status: P1 channels proven; the panel routes.** A study can arrive by C-STORE or by
an upload batch from a center's agent token, be attributed to its tenant, linked to
its order, and carry an SLA clock; a study that matches nothing waits in the orphan
queue where a person can link it. The console shows which readers are routable right
now, and the dispatcher offers a case **only** to a green reader whose profile covers
it — accept it, decline it with a reason, or let the offer lapse and rotate. There is
still no viewer, no report and no money, and nothing pages a person when a case cannot
be routed. Nothing in here has received a patient study. The inventory at the end of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the honest state.

Standalone product. It is not a CARE ERP module, it does not call the FutureKind
gateway, and it keeps its own patients, tenants, reports and money. The only
borrowed thing is deployment technique: Orthanc + OHIF + Synology Docker, the way
`care-pacs` already runs it — minus that repository's anonymous Orthanc.

## Four surfaces

| Surface | User | Content |
| --- | --- | --- |
| Ingest edge | center's modality or uploader | Orthanc C-STORE, watched folders, browser upload |
| Worklist | radiologist | offers with a padlock, accept or decline-with-a-reason, lapse countdown; no viewer, no auto-next yet |
| Report desk | radiologist, reviewer | draft → sign → countersign → deliver → amend |
| Console | owner, center admin | tenants, tariffs, rosters, QC, invoices, payouts |

## Layout

    apps/api        Express + Drizzle, the only writer of clinical state
    apps/worker     ingest poller, inbox drain, study classifier, SLA clock
    apps/web        the console: on-panel board now, worklist and reporting later
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
