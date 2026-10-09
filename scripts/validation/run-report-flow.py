#!/usr/bin/env python3
"""The report lifecycle, driven over HTTP against the live stack.

A reader who accepts a case has to be able to sign something for it, and a signature is
the one place in this product where a wrong permission becomes a medical document with the
wrong name on it. So this flow is mostly refusals: who may write, who may sign, who may add
the second name, and what happens to the version that was corrected.

Readers, all seeded by the same CLI with different grades on purpose:

    Dr Green   radiologist, senior  — holds the case, writes and signs it
    Dr Junior  radiologist, junior  — may read it, may NOT clear it, may NOT amend it
    Dr Second  reviewer,    chief   — clears it, then amends it

Phases, with the worker run by the operator between them:

  python scripts/validation/run-report-flow.py --phase prepare
  ... pnpm --filter @telrad/worker once        # inbox -> Orthanc
  ... wait for Orthanc to call the study stable
  ... pnpm --filter @telrad/worker once        # poll, link by accession, open the clock
  ... pnpm --filter @telrad/worker dispatch-once
  python scripts/validation/run-report-flow.py --phase accept
  python scripts/validation/run-report-flow.py --phase check
  python scripts/validation/run-report-flow.py --phase late-clock-after-sign

The last phase moves an already-signed clock's deadline to a point after the signature but
before now, and runs the sweep over it. Nothing may fire and no breach may be stamped: `dueStages` returns nothing
once `signed_at` exists, and `isBreached` measures the signature against the deadline
rather than the deadline against the wall clock. A case that was answered inside its window
stays answered, however the clock underneath it is rewritten afterwards.

The clock is moved by rewriting `deadline_at`, never by backdating `received_at`: a tighter
contract is the real-world cause, and `received_at` is a fact about the scanner.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "flow", Path("scripts/validation/run-escalation-flow.py").resolve())
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

API = flow.API
GREEN = flow.GREEN
SECOND = "dr-second@test.local"
JUNIOR = "dr-junior@test.local"

SUB, ACC, MRN, NAME = "rep1", "ACC-REP-1", "P-REP-1", "Kavita Rao"
MODALITY, SPECIALTY, PRIORITY = "CT", "ct-head", "urgent"
FINDINGS = "No acute intracranial haemorrhage. No mass effect. Ventricles and sulci are " \
           "age appropriate."
IMPRESSION = "No acute pathology on the available slices."
AMENDED_IMPRESSION = "No acute pathology. A small right parietal hypodensity is noted, " \
                     "clinical correlation suggested."

TOKEN = {"token": None}


def study_for(email, accession):
    for case in flow.work_of(email):
        if case["accession"] == accession:
            return case
    return None


def report_of(api, study_id):
    return api.call("GET", f"/v1/reports/current?studyId={study_id}")


def fetch_bytes(api, path):
    """A PDF is bytes, not JSON, and the shared helper decodes. The cookie jar and the
    bearer token come from the same session, so this is the same request the browser makes."""
    import urllib.request
    req = urllib.request.Request(api.base + path, method="GET",
                                 headers={"Authorization": "Bearer " + api.bearer} if api.bearer else {})
    try:
        with api.opener.open(req, timeout=30) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def psql(sql):
    out = subprocess.run(["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad",
                          "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        return f"ERROR {out.stderr.strip()[:160]}"
    return out.stdout.strip()


def phase_prepare():
    api = flow.owner()
    today = datetime.date.today().strftime("%Y%m%d")

    status, body = api.call("POST", "/v1/patients", {
        "tenantId": 1, "mrn": MRN, "fullName": NAME, "gender": "F", "dob": "19680719",
    })
    patient_id = body.get("patient", {}).get("id")
    flow.check("patient", status in (200, 201) and bool(patient_id), str(status))

    status, body = api.call("POST", "/v1/orders", {
        "tenantId": 1, "accessionNumber": ACC, "patientId": patient_id,
        "modalityCode": MODALITY, "subSpecialtyCode": SPECIALTY, "priority": PRIORITY,
        "scheduledDate": today, "clinicalIndication": "report flow — sudden headache",
        "referringName": "Dr Referrer",
    })
    flow.check("order", status in (200, 201), json.dumps(body)[:120])

    status, body = api.call("POST", "/v1/sites", {
        "tenantId": 1, "name": "Report test site", "aeTitle": "REP_SCANNER_1",
    })
    site_id = body.get("site", {}).get("id") if status == 201 else 1
    status, body = api.call("POST", f"/v1/sites/{site_id}/tokens", {"label": "report agent", "ttlDays": 7})
    TOKEN["token"] = body.get("token")
    flow.check("agent token", status == 201 and bool(TOKEN["token"]), str(status))

    directory = Path("scripts/validation/out") / SUB
    files = sorted(p.name for p in directory.glob("*.dcm"))
    flow.check("three instances generated", len(files) == 3, str(files))

    agent = flow.Api(API)
    agent.bearer = TOKEN["token"]
    status, body = agent.call("POST", "/v1/uploads/batches", {
        "filesExpected": len(files), "accessionHint": ACC, "modalityHint": MODALITY,
        "studyDateHint": today,
    })
    batch = body.get("batchId")
    flow.check("batch opened", status == 201 and bool(batch), json.dumps(body)[:120])
    for name in files:
        raw = (directory / name).read_bytes()
        status, _ = agent.call("PUT", f"/v1/uploads/batches/{batch}/files/{name}", raw=raw,
                               headers={"X-Content-Sha256": hashlib.sha256(raw).hexdigest(),
                                        "Content-Type": "application/dicom"})
        flow.check(f"put {name}", status == 200, str(status))
    status, body = agent.call("POST", f"/v1/uploads/batches/{batch}/seal", {})
    flow.check("seal", status == 200, json.dumps(body)[:120])


def phase_accept():
    case = study_for(GREEN, ACC)
    flow.check("the CT reached the reader who covers heads", case is not None,
               json.dumps([(c["accession"], c["state"]) for c in flow.work_of(GREEN)]))
    if not case:
        return
    status, body = flow.login(GREEN).call(
        "POST", f"/v1/assignments/{case['assignmentId']}/accept", {})
    flow.check("green accepts", status == 200, json.dumps(body)[:120])


def phase_check():
    green, junior, second, ops = (flow.login(GREEN), flow.login(JUNIOR), flow.login(SECOND), flow.owner())
    case = study_for(GREEN, ACC)
    if not case:
        flow.check("the case is still held by green", False, "not on the desk")
        return
    study_id = case["studyId"]

    # ---- who may start writing ------------------------------------------------------
    status, body = junior.call("POST", "/v1/reports", {"studyId": study_id})
    flow.check("a reader who does not hold it cannot start a report",
               status == 403 and body.get("error") == "not_your_case", f"{status} {body}")

    status, body = report_of(junior, study_id)
    flow.check("nothing written yet", status == 404 and body.get("error") == "no_report", str(status))

    status, body = green.call("POST", "/v1/reports", {"studyId": study_id})
    draft = body.get("report", {})
    flow.check("the holder starts a draft", status == 201 and draft.get("state") == "draft"
               and draft.get("version") == 1, f"{status} {json.dumps(body)[:140]}")
    report_id = draft.get("id")
    flow.check("a blank draft names both required fields",
               draft.get("gaps") == ["findings", "impression"], json.dumps(draft.get("gaps")))
    flow.check("the report knows its own sub-specialty needs a second name",
               draft.get("study", {}).get("requiresReviewer") is True, str(draft.get("study")))

    # A draft is not a document yet, and that has to hold for both doors into the study.
    status, body = junior.call("GET", f"/v1/reports/{report_id}")
    flow.check("a colleague cannot read somebody else's draft",
               status == 404 and body.get("error") == "not_found", f"{status} {body}")
    status, body = junior.call("GET", f"/v1/view/{study_id}")
    flow.check("and cannot open its images either",
               status == 403 and body.get("error") == "not_your_case", f"{status} {body}")

    # ---- the document ---------------------------------------------------------------
    status, body = green.call("PATCH", f"/v1/reports/{report_id}",
                              {"sections": {"impressionn": IMPRESSION}})
    flow.check("a misspelled section is refused, not silently dropped",
               status == 400 and body.get("error") == "unknown_section", f"{status} {body}")

    status, body = green.call("PATCH", f"/v1/reports/{report_id}", {"sections": {"findings": FINDINGS}})
    saved = body.get("report", {})
    flow.check("findings saved", status == 200 and saved.get("gaps") == ["impression"],
               json.dumps(saved.get("gaps")))

    status, body = green.call("POST", f"/v1/reports/{report_id}/sign", {})
    flow.check("signing refuses while the impression is blank",
               status == 422 and body.get("error") == "sections_blank:impression", f"{status} {body}")

    status, body = green.call("PATCH", f"/v1/reports/{report_id}", {"sections": {"impression": IMPRESSION}})
    flow.check("impression saved", status == 200 and body.get("report", {}).get("gaps") == [],
               json.dumps(body.get("report", {}).get("gaps")))

    # ---- signatures -----------------------------------------------------------------
    status, body = green.call("POST", f"/v1/reports/{report_id}/sign", {})
    signed = body.get("report", {})
    flow.check("the author signs", status == 200 and signed.get("state") == "signed",
               f"{status} {json.dumps(body)[:140]}")
    author = signed.get("author", {})
    flow.check("the signature block carries the registration number, not the screen name",
               author.get("registration") == "WB-100001" and author.get("name") == "Dr Green",
               json.dumps(author))
    flow.check("signed_at is stamped and no second name exists yet",
               bool(signed.get("signedAt")) and signed.get("reviewer") is None,
               json.dumps([signed.get("signedAt"), signed.get("reviewer")]))
    flow.check("the author is offered no countersignature of their own",
               signed.get("can", {}).get("countersign") is False
               and signed.get("can", {}).get("edit") is False, json.dumps(signed.get("can")))

    status, body = green.call("PATCH", f"/v1/reports/{report_id}", {"sections": {"impression": "edited"}})
    flow.check("a signed report refuses an edit",
               status == 409 and body.get("error") == "signed_report_is_immutable", f"{status} {body}")

    status, body = green.call("POST", f"/v1/reports/{report_id}/sign", {})
    flow.check("and refuses a second signature from the same name",
               status == 422 and body.get("error") == "not_a_draft", f"{status} {body}")

    gone = study_for(GREEN, ACC)
    flow.check("signing completes the read, so the queue slot is freed",
               gone is None, json.dumps([(c["accession"], c["state"]) for c in flow.work_of(GREEN)]))

    # Signing takes the case off the desk that led to it, so the desk cannot be the only
    # door back to the images a reader has just described.
    status, body = green.call("GET", f"/v1/view/{study_id}")
    flow.check("the author can still open the images after signing",
               status == 200 and (body.get("reportAccess") or {}).get("as") == "author",
               f"{status} {json.dumps(body.get('reportAccess'))[:80]}")
    status, body = junior.call("GET", f"/v1/view/{study_id}")
    flow.check("and a colleague reaches them as a prospective second name, not as a holder",
               status == 200 and (body.get("reportAccess") or {}).get("as") == "review",
               f"{status} {json.dumps(body.get('reportAccess'))[:80]}")

    queue = [i for i in junior.call("GET", "/v1/reports/awaiting-review")[1].get("awaiting", [])]
    flow.check("the report is waiting for a second name", len(queue) == 1, json.dumps(queue)[:160])
    flow.check("a junior is told why they cannot clear it",
               queue and queue[0].get("mayClear") is False
               and queue[0].get("reason") == "grade_below_author",
               json.dumps(queue[0] if queue else None)[:160])

    own = [i for i in green.call("GET", "/v1/reports/awaiting-review")[1].get("awaiting", [])]
    flow.check("an author is not shown their own report as work to do", own == [], json.dumps(own)[:160])

    status, body = junior.call("POST", f"/v1/reports/{report_id}/countersign", {})
    flow.check("the refusal is the same rule the queue named",
               status == 422 and body.get("error") == "grade_below_author", f"{status} {body}")

    status, body = second.call("POST", f"/v1/reports/{report_id}/countersign", {})
    verified = body.get("report", {})
    flow.check("a chief reviewer clears it", status == 200 and verified.get("state") == "verified",
               f"{status} {json.dumps(body)[:140]}")
    flow.check("the two names are different people and both registrations are stored",
               verified.get("reviewer", {}).get("registration") == "WB-200002"
               and verified.get("author", {}).get("registration") == "WB-100001"
               and verified.get("reviewer", {}).get("userId") != verified.get("author", {}).get("userId"),
               json.dumps([verified.get("author"), verified.get("reviewer")])[:200])

    status, body = second.call("POST", f"/v1/reports/{report_id}/countersign", {})
    flow.check("a report is cleared once", status == 422 and body.get("error") == "not_signed",
               f"{status} {body}")

    # ---- delivery -------------------------------------------------------------------
    # `verified` is the first state a document may leave in, and this is where
    # sub_specialties.requires_reviewer stops being a caption on the screen.
    status, body = ops.call("GET", "/v1/reports/awaiting-delivery")
    listed = [d for d in body.get("awaiting", []) if d.get("reportId") == report_id]
    flow.check("the desk lists the cleared report as waiting to go",
               status == 200 and len(listed) == 1 and listed[0].get("deliverable") is True,
               f"{status} {json.dumps(listed)[:160]}")
    flow.check("and names the clinician it goes to",
               listed and listed[0].get("referringName") == "Dr Referrer",
               json.dumps(listed[0].get("referringName") if listed else None))

    status, body = green.call("GET", "/v1/reports/awaiting-delivery")
    flow.check("a reader has no delivery board", status == 403, f"{status} {body}")

    status, pdf, headers = fetch_bytes(ops, f"/v1/reports/{report_id}/pdf")
    first_sha = hashlib.sha256(pdf).hexdigest()
    flow.check("the PDF is a PDF, sent as an attachment and never cached",
               status == 200 and pdf[:5] == b"%PDF-"
               and headers.get("Content-Type") == "application/pdf"
               and headers.get("Cache-Control") == "no-store"
               and "telrad-ACC-REP-1-v1.pdf" in headers.get("Content-Disposition", ""),
               f"{status} {json.dumps({k: headers.get(k) for k in ('Content-Type', 'Cache-Control', 'Content-Disposition')})}")
    status, pre_body = ops.call("GET", f"/v1/reports/{report_id}")
    pre = pre_body.get("report", {})
    flow.check("nothing is recorded as delivered before the act",
               pre.get("state") == "verified" and pre.get("deliveredAt") is None
               and pre.get("delivery", {}).get("pdfSha256") is None,
               json.dumps([pre.get("state"), pre.get("deliveredAt"),
                           pre.get("delivery", {}).get("pdfSha256")])[:160])
    flow.check("the desk is told it may release this one",
               pre.get("can", {}).get("deliver") is True and pre.get("can", {}).get("download") is True,
               json.dumps(pre.get("can"))[:180])
    status, reader_body = green.call("GET", f"/v1/reports/{report_id}")
    flow.check("and a reader holding it sees the document, not the release button",
               reader_body.get("report", {}).get("can", {}).get("showDelivery") is False
               and reader_body.get("report", {}).get("can", {}).get("download") is True,
               json.dumps(reader_body.get("report", {}).get("can"))[:180])

    status, body = green.call("POST", f"/v1/reports/{report_id}/deliver", {})
    flow.check("the reader who signed it cannot release it", status == 403, f"{status} {body}")

    status, body = ops.call("POST", f"/v1/reports/{report_id}/deliver", {})
    delivered = body.get("report", {})
    flow.check("the desk delivers it", status == 200 and delivered.get("state") == "delivered",
               f"{status} {json.dumps(body)[:140]}")
    flow.check("delivery records the hash of the document that left",
               delivered.get("delivery", {}).get("pdfSha256") == first_sha
               and bool(delivered.get("deliveredAt")),
               json.dumps([delivered.get("delivery", {}).get("pdfSha256"), first_sha])[:160])

    status, body = ops.call("POST", f"/v1/reports/{report_id}/deliver", {})
    flow.check("and it goes once", status == 422 and body.get("error") == "already_delivered",
               f"{status} {body}")

    status, body = ops.call("GET", "/v1/reports/awaiting-delivery")
    gone = [d for d in body.get("awaiting", []) if d.get("reportId") == report_id]
    flow.check("a delivered report leaves the desk's waiting list", gone == [], json.dumps(gone)[:120])

    status, again, _ = fetch_bytes(ops, f"/v1/reports/{report_id}/pdf")
    flow.check("re-rendering the delivered report produces the same bytes, so the hash means something",
               status == 200 and hashlib.sha256(again).hexdigest() == first_sha,
               f"{status} {hashlib.sha256(again).hexdigest()[:16]} vs {first_sha[:16]}")

    stamped = psql(f"select count(*) from telrad.sla_clocks c join telrad.studies s on s.id = c.study_id "
                   f"where s.accession_number = '{ACC}' and c.delivered_at is not null;")
    flow.check("the clock carries the delivery time", stamped.strip() == "1", stamped)

    delivery_row = psql("select d.channel || '|' || d.status || '|' || d.idempotency_key || '|' || d.recipient "
                        "from telrad.report_deliveries d "
                        f"join telrad.reports r on r.id = d.report_id where r.id = {report_id};")
    flow.check("one sent delivery row, keyed to this report version",
               delivery_row.strip() == f"portal|sent|report:{report_id}:v1:portal|Dr Referrer", delivery_row)

    # ---- amendment ------------------------------------------------------------------
    status, body = second.call("POST", f"/v1/reports/{report_id}/amend", {})
    flow.check("an amendment without a reason is refused",
               status == 422 and body.get("error") == "reason_required", f"{status} {body}")

    status, body = junior.call("POST", f"/v1/reports/{report_id}/amend", {"reason": "second thought"})
    flow.check("a junior cannot amend a senior's report",
               status == 422 and body.get("error") == "grade_not_above_author", f"{status} {body}")

    status, body = green.call("POST", f"/v1/reports/{report_id}/amend", {"reason": "my own report"})
    flow.check("and neither can the author of the version being corrected",
               status == 422 and body.get("error") == "grade_not_above_author", f"{status} {body}")

    status, body = second.call("POST", f"/v1/reports/{report_id}/amend",
                               {"reason": "Small right parietal hypodensity visible on re-read."})
    v2 = body.get("report", {})
    flow.check("the reviewer amends it into a new draft version",
               status == 201 and v2.get("version") == 2 and v2.get("state") == "draft",
               f"{status} {json.dumps(body)[:140]}")
    flow.check("the new version supersedes the old one by id",
               v2.get("supersedesReportId") == report_id, str(v2.get("supersedesReportId")))
    flow.check("and names the version it corrects, not just the row",
               v2.get("supersedesVersion") == 1, str(v2.get("supersedesVersion")))
    flow.check("an amendment starts from the words it corrects, not from a blank page",
               v2.get("sections", {}).get("findings") == FINDINGS, str(v2.get("sections"))[:120])
    flow.check("the amender is the author of the new version",
               v2.get("author", {}).get("registration") == "WB-200002", json.dumps(v2.get("author")))
    v2_id = v2.get("id")

    status, body = report_of(ops, study_id)
    current = body.get("report", {})
    flow.check("the study answers with the newest live version",
               status == 200 and current.get("version") == 2 and current.get("id") == v2_id,
               f"{status} v{current.get('version')}")

    status, body = second.call("GET", f"/v1/reports/{report_id}")
    old = body.get("report", {})
    flow.check("the superseded version keeps both names and both timestamps",
               old.get("state") == "amended" and bool(old.get("signedAt"))
               and bool(old.get("verifiedAt")) and old.get("reviewer", {}).get("registration") == "WB-200002",
               json.dumps([old.get("state"), old.get("signedAt"), old.get("verifiedAt")]))
    flow.check("and lists every version in the chain",
               [h.get("version") for h in old.get("history", [])] == [2, 1],
               json.dumps(old.get("history")))

    status, body = second.call("POST", f"/v1/reports/{v2_id}/sign", {})
    flow.check("the amended report has to be signed again", status == 200
               and body.get("report", {}).get("state") == "signed", f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("POST", f"/v1/reports/{v2_id}/deliver", {})
    flow.check("an unsigned second name stops the corrected version leaving",
               status == 422 and body.get("error") == "review_required", f"{status} {body}")

    status, body = ops.call("GET", "/v1/reports/awaiting-delivery")
    waiting = [d for d in body.get("awaiting", []) if d.get("reportId") == v2_id]
    flow.check("and the desk can see why, on the row, without asking",
               len(waiting) == 1 and waiting[0].get("deliverable") is False
               and waiting[0].get("reason") == "review_required"
               and waiting[0].get("needsSecondName") is True,
               f"{status} {json.dumps(waiting)[:200]}")

    status, body = ops.call("GET", f"/v1/reports/{report_id}")
    history_row = body.get("report", {})
    flow.check("superseding a delivered report does not erase that it was delivered",
               history_row.get("state") == "amended" and bool(history_row.get("deliveredAt"))
               and bool(history_row.get("delivery", {}).get("pdfSha256")),
               json.dumps([history_row.get("state"), history_row.get("deliveredAt"),
                           (history_row.get("delivery", {}).get("pdfSha256") or "")[:12]])[:160])

    flow.check("and the version that replaced it is named, not inferred",
               history_row.get("supersededByVersion") == 2
               and history_row.get("can", {}).get("download") is True,
               json.dumps([history_row.get("supersedesVersion"), history_row.get("supersededByVersion")]))

    status, old_pdf, _ = fetch_bytes(ops, f"/v1/reports/{report_id}/pdf")
    drift = hashlib.sha256(old_pdf).hexdigest()
    flow.check("a superseded version still renders, and is a different document from the one sent",
               status == 200 and old_pdf[:5] == b"%PDF-"
               and drift != (history_row.get("delivery", {}).get("pdfSha256") or ""),
               f"{status} {drift[:16]} vs record {(history_row.get('delivery', {}).get('pdfSha256') or '')[:16]}")
    # The banner naming v2 changes the bytes, so the hash of what was delivered no longer
    # matches a fresh render. That is recorded rather than hidden: the audit row carries both
    # values and says they do not match, which is the honest answer to "is this the PDF we got".
    drifted = psql("select count(*) from telrad.audit_log where action = 'report.pdf_downloaded' "
                   f"and entity_id = '{report_id}' and detail->>'matchesRecord' = 'false' "
                   f"and detail->>'recordSha256' = '{first_sha}';")
    flow.check("and the mismatch against the delivered record is written down",
               drifted.strip() == "1", drifted)

    # ---- what an operator can see ---------------------------------------------------
    mine_green = [m["reportId"] for m in green.call("GET", "/v1/reports/mine")[1].get("reports", [])]
    flow.check("the author can find the version they signed, which is now history",
               report_id in mine_green, json.dumps(mine_green)[:120])
    mine_second = [m["reportId"] for m in second.call("GET", "/v1/reports/mine")[1].get("reports", [])]
    flow.check("and so can the reviewer who amended it", v2_id in mine_second, json.dumps(mine_second)[:120])

    status, body = junior.call("GET", f"/v1/reports/{report_id}")
    flow.check("a colleague in the same tenant can read it",
               status == 200 and body.get("report", {}).get("id") == report_id, str(status))

    actions = [e.get("action") for e in ops.call("GET", "/v1/audit/latest")[1].get("entries", [])]
    for needed in ["report.signed", "report.countersigned", "report.amended", "report.draft_saved",
                   "report.delivered", "report.pdf_downloaded", "report.delivery_queue"]:
        flow.check(f"the audit chain carries {needed}", needed in actions, json.dumps(actions[:12]))


def phase_late_clock_after_sign():
    """Signing must stop both the actions *and* the blame.

    The clock is rewritten so its deadline now sits in the past, which is exactly what a
    re-clock or a renegotiated contract does to an already-answered case. Nothing may fire
    and no breach may be stamped, because lateness is measured against the signature: a
    report signed inside its window was on time, and a deadline moved afterwards cannot say
    otherwise. This is the number a center's QC report gets billed against.
    """
    ops = flow.owner()
    before = [c for c in ops.call("GET", "/v1/escalations")[1].get("late", [])
              if c.get("accession") == ACC]
    flow.check("a report signed inside its window is not on the late board",
               before == [], json.dumps(before)[:160])

    # The deadline has to land *between* the signature and now. Measured from received_at it
    # would sit before the signature, which is a genuine late answer rather than the case
    # under test — the whole point here is a clock rewritten after somebody already answered
    # inside its window.
    sql = ("update telrad.sla_clocks c set deadline_at = c.signed_at "
           "+ (now() - c.signed_at) * (100.0/130) "
           f"from telrad.studies s where s.id = c.study_id and s.accession_number = '{ACC}' "
           "and c.signed_at is not null;")
    pushed = subprocess.run(["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad", "-c", sql],
                            capture_output=True, text=True)
    flow.check("the signed clock was pushed past its deadline", pushed.returncode == 0,
               (pushed.stderr or pushed.stdout)[:160])

    stamp = subprocess.run(
        ["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad", "-tAc",
         "select count(*) from telrad.sla_clocks c join telrad.studies s on s.id = c.study_id "
         f"where s.accession_number = '{ACC}' and c.breached;"],
        capture_output=True, text=True)
    flow.check("no breach flag had been written before the deadline moved",
               stamp.stdout.strip() == "0", f"breached_rows={stamp.stdout.strip()[:20]}")

    ran = subprocess.run("pnpm --filter @telrad/worker dispatch-once", shell=True,
                         capture_output=True, text=True)
    flow.check("the sweep ran over it", ran.returncode == 0, (ran.stderr or ran.stdout)[-200:])

    after = [c for c in ops.call("GET", "/v1/escalations")[1].get("late", [])
             if c.get("accession") == ACC]
    flow.check("it is still not late, because the signature was inside the window",
               after == [], json.dumps(after)[:200])

    escalated = subprocess.run(
        ["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad", "-tAc",
         "select count(*) from telrad.audit_log where action in ('sla.escalated','sla.breached') "
         f"and detail->>'accession' = '{ACC}'"],
        capture_output=True, text=True)
    flow.check("and nothing in the audit trail says it was escalated or breached",
               escalated.stdout.strip() == "0", f"count={escalated.stdout.strip()[:40]}")

    for email in (GREEN, SECOND, JUNIOR):
        held = [c for c in flow.work_of(email) if c["accession"] == ACC]
        flow.check(f"the answered case was not offered to {email.split('@')[0]} again",
                   held == [], json.dumps(held)[:120])

    # The desk lists is only as good as the readers it knows about, so the queue is also
    # asked directly: a study with a signature on it must not be sitting in anybody's
    # pending offer. The first run that took a report to a countersignature produced exactly
    # that — a fresh offer for a study two names had already answered.
    live = subprocess.run(
        ["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad", "-tAc",
         "select count(*) from telrad.assignments a join telrad.studies s on s.id = a.study_id "
         f"where s.accession_number = '{ACC}' "
         "and a.state in ('offered','accepted','reading');"],
        capture_output=True, text=True)
    flow.check("and no live assignment for it survives the sweep",
               live.stdout.strip() == "0", f"live_assignments={live.stdout.strip()[:20]}")
    print(f"worker: {(ran.stdout or '').strip()[-300:]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True,
                        choices=["prepare", "accept", "check", "late-clock-after-sign"])
    args = parser.parse_args()
    {"prepare": phase_prepare, "accept": phase_accept, "check": phase_check,
     "late-clock-after-sign": phase_late_clock_after_sign}[args.phase]()
    if flow.FAILED:
        print(f"\n{len(flow.FAILED)} assertion(s) failed: {', '.join(flow.FAILED)}")
        sys.exit(1)
    print("\nall report assertions passed")


if __name__ == "__main__":
    main()
