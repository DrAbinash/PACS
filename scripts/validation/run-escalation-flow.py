#!/usr/bin/env python3
"""Escalation acceptance flow: what the system does when a clock runs out.

The routing test proves a case reaches a green reader. This proves the other half —
that a case which *cannot* reach one stops being silent. Three studies and three
readers, each existing to exercise one rule:

    A  DX chest   ACC-ESC-A   Dr Chest accepts it, which fills his one-slot queue and
                              turns him amber. He is the at-cap reader the rest of the
                              run depends on.
    B  DX chest   ACC-ESC-B   Only Dr Chest covers it. At stage 0 it must stay
                              unassigned with the reason visible; once its clock reaches
                              the widen_pool stage it must be offered to him anyway.
    C  MRI spine  ACC-ESC-C   Nobody covers MRI at all. The only reader with full cover
                              is Dr Paused, who is amber for a different reason. C must
                              stay blocked through every stage — widening relaxes
                              capacity, never coverage — and then take a manual assign.

Between phases the operator runs the worker and moves the clocks. The clocks are moved
by shortening the deadline rather than by backdating `received_at`, because a tighter
contract is the real-world cause and `received_at` is a fact about the scanner:

  docker exec tr-ci psql -U telrad -d telrad -c "
    update telrad.sla_clocks c set deadline_at = s.received_at + (now() - s.received_at) * (100.0/60)
      from telrad.studies s where s.id = c.study_id and s.accession_number = 'ACC-ESC-B';"

  docker exec ... pnpm --filter @telrad/worker dispatch-once    # escalate, then dispatch

Phases:

  python scripts/validation/run-escalation-flow.py --phase prepare
  ... worker once ...
  python scripts/validation/run-escalation-flow.py --phase presence
  python scripts/validation/run-escalation-flow.py --phase accept
  ... clock B and C to 60%, worker dispatch-once ...
  python scripts/validation/run-escalation-flow.py --phase check --expect stage1
  python scripts/validation/run-escalation-flow.py --phase take-widened
  ... clock B to 80%, worker dispatch-once ...
  python scripts/validation/run-escalation-flow.py --phase check --expect stage2
  ... clock C to 98%, worker dispatch-once ...
  python scripts/validation/run-escalation-flow.py --phase check --expect manual
  ... clock B to 130%, worker dispatch-once twice ...
  python scripts/validation/run-escalation-flow.py --phase check --expect breach
"""
import argparse
import datetime
import hashlib
import http.cookiejar
import json
import os
import sys
import urllib.request
from pathlib import Path

API = os.environ.get("ESC_API", "http://127.0.0.1:3101")
OWNER = ("ops@test.local", "testonly-passphrase-42")
PASSWORD = "testonly-passphrase-42"

CHEST = "dr-chest@test.local"
GREEN = "dr-green@test.local"
PAUSED = "dr-paused@test.local"

STUDIES = [
    # dir, accession, mrn, name, modality, sub-specialty, order priority
    ("escA", "ACC-ESC-A", "P-ESC-A", "Anita Rao", "DX", "dx-chest", "routine"),
    ("escB", "ACC-ESC-B", "P-ESC-B", "Ramesh Kumar", "DX", "dx-chest", "urgent"),
    ("escC", "ACC-ESC-C", "P-ESC-C", "Suresh N", "MR", "mr-spine", "routine"),
]


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.bearer = None

    def call(self, method, path, body=None, headers=None, raw=None):
        hdrs = dict(headers or {})
        if self.bearer:
            hdrs["Authorization"] = "Bearer " + self.bearer
        data = None
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with self.opener.open(req, timeout=30) as res:
                text = res.read().decode()
                return res.status, json.loads(text) if text else {}
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            try:
                return err.code, json.loads(text) if text else {}
            except json.JSONDecodeError:
                return err.code, {"raw": text[:200]}


FAILED = []


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    if not ok:
        FAILED.append(name)


def login(email, password=PASSWORD):
    api = Api(API)
    status, body = api.call("POST", "/v1/auth/login", {"email": email, "password": password})
    if status != 200:
        raise SystemExit(f"login failed for {email}: {status} {body}")
    return api


def owner():
    return login(OWNER[0], OWNER[1])


def work_of(email):
    status, body = login(email).call("GET", "/v1/my/work")
    if status != 200:
        raise SystemExit(f"/v1/my/work {email}: {status} {body}")
    return body.get("cases", [])


def escalations():
    status, body = owner().call("GET", "/v1/escalations")
    if status != 200:
        raise SystemExit(f"/v1/escalations: {status} {body}")
    return body


def unassigned():
    status, body = owner().call("GET", "/v1/dispatch/unassigned")
    if status != 200:
        raise SystemExit(f"/v1/dispatch/unassigned: {status} {body}")
    return body


def clock_for(accession):
    for row in escalations().get("late", []):
        if row.get("accession") == accession:
            return row
    return None


def phase_prepare():
    api = owner()
    today = datetime.date.today().strftime("%Y%m%d")
    token = None
    for _sub, acc, mrn, name, modality, specialty, priority in STUDIES:
        status, body = api.call("POST", "/v1/patients", {
            "tenantId": 1, "mrn": mrn, "fullName": name, "gender": "U", "dob": "19800101",
        })
        check(f"patient {mrn}", status in (200, 201), str(status))
        patient_id = body.get("patient", {}).get("id")
        status, body = api.call("POST", "/v1/orders", {
            "tenantId": 1, "accessionNumber": acc, "patientId": patient_id,
            "modalityCode": modality, "subSpecialtyCode": specialty, "priority": priority,
            "scheduledDate": today, "clinicalIndication": "escalation flow",
            "referringName": "Dr Referrer",
        })
        check(f"order {acc}", status in (200, 201), json.dumps(body)[:120])

    status, body = api.call("POST", "/v1/sites", {
        "tenantId": 1, "name": "Escalation test site", "aeTitle": "ESC_SCANNER_1",
    })
    if status == 409:
        body = {"site": {"id": 1}}
    site_id = body.get("site", {}).get("id", 1)
    status, body = api.call("POST", f"/v1/sites/{site_id}/tokens", {"label": "escalation agent", "ttlDays": 7})
    token = body.get("token")
    check("agent token", status == 201 and bool(token), str(status))

    for sub, acc, _mrn, _name, modality, _specialty, _priority in STUDIES:
        directory = Path("scripts/validation/out") / sub
        files = sorted(p.name for p in directory.glob("*.dcm"))
        agent = Api(API)
        agent.bearer = token
        status, body = agent.call("POST", "/v1/uploads/batches", {
            "filesExpected": len(files), "accessionHint": acc, "modalityHint": modality,
            "studyDateHint": datetime.date.today().strftime("%Y%m%d"),
        })
        check(f"open batch {acc}", status == 201, str(status))
        batch = body.get("batchId")
        for name in files:
            raw = (directory / name).read_bytes()
            status, body = agent.call("PUT", f"/v1/uploads/batches/{batch}/files/{name}", raw=raw,
                                      headers={"X-Content-Sha256": hashlib.sha256(raw).hexdigest(),
                                               "Content-Type": "application/dicom"})
            check(f"put {acc}/{name}", status == 200, str(status))
        status, body = agent.call("POST", f"/v1/uploads/batches/{batch}/seal", {})
        check(f"seal {acc}", status == 200, json.dumps(body)[:140])


def phase_presence():
    for label, email in (("chest", CHEST), ("green", GREEN), ("paused", PAUSED)):
        api = login(email)
        status, body = api.call("POST", "/v1/presence/heartbeat", {})
        check(f"heartbeat {label}", status == 200,
              f"{body.get('color')}/{body.get('code')} routable={body.get('routable')}")
    api = login(PAUSED)
    status, _ = api.call("PATCH", "/v1/presence", {"state": "paused"})
    check("paused declares paused", status == 200, str(status))
    status, body = api.call("POST", "/v1/presence/heartbeat", {})
    check("a heartbeat does not un-pause a reader", body.get("routable") is False,
          f"{body.get('color')}/{body.get('code')}")


def phase_accept():
    """Dr Chest takes A, which fills his single slot and makes him the at-cap reader."""
    cases = work_of(CHEST)
    check("chest holds exactly one case", len(cases) == 1 and cases[0]["subSpecialty"] == "dx-chest",
          json.dumps([(c["state"], c["accession"]) for c in cases]))
    api = login(CHEST)
    status, body = api.call("POST", f"/v1/assignments/{cases[0]['assignmentId']}/accept", {})
    check("chest accepts A", status == 200, json.dumps(body)[:120])
    status, body = api.call("POST", "/v1/presence/heartbeat", {})
    check("a full reader reads amber, not green",
          body.get("color") == "amber" and body.get("code") == "at_cap",
          f"{body.get('color')}/{body.get('code')} {body.get('openCases')}/{body.get('maxQueueSize')}")


def blocked_by(accession_suffix):
    for row in unassigned().get("unassigned", []):
        if (row.get("subSpecialty") or "").endswith(accession_suffix):
            return row
    return None


def expect_stage1():
    b = clock_for("ACC-ESC-B")
    check("B is on the late board at stage 1", b is not None and b["stage"] == 1,
          json.dumps({k: b.get(k) for k in ("accession", "stage", "elapsedPct", "breached")}) if b else "absent")
    if b:
        check("B's stage-1 escalation opened its window", b["elapsedPct"] >= 55, f"elapsed={b['elapsedPct']}%")
        holder = b.get("holder") or {}
        check("B was widened onto the at-cap reader",
              holder.get("name") == "Dr Chest" and holder.get("state") == "offered",
              json.dumps(holder))
    c = clock_for("ACC-ESC-C")
    check("C is on the late board at stage 1", c is not None and c["stage"] == 1,
          json.dumps({k: c.get(k) for k in ("accession", "stage", "elapsedPct")}) if c else "absent")
    if c:
        check("widening did not hand the MRI to a paused reader", c.get("holder") is None,
              json.dumps(c.get("holder")))
    row = blocked_by("spine")
    # The nearest reader for C is Dr Paused, who covers everything but is paused. That is
    # the point: widening admits an at-cap reader and nothing else, so the one miss the
    # stage cannot fix stays a miss and the case stays unheld.
    check("C is still blocked with the reason widening cannot fix",
          row is not None and row["status"] == "blocked" and row["poolWidened"] is True
          and "not_routable" in (row["nearestReader"] or {}).get("missing", []),
          json.dumps({k: row.get(k) for k in ("status", "poolWidened", "nearestReader")}) if row else "absent")
    chest = work_of(CHEST)
    check("chest now holds two cases, one of them a widened offer",
          len(chest) == 2 and sum(1 for x in chest if x["state"] == "accepted") == 1
          and sum(1 for x in chest if x["state"] == "offered") == 1,
          json.dumps([(x["state"], x["accession"]) for x in chest]))
    counts = escalations().get("counts", {})
    check("the board counts the unheld case", counts.get("unheld", 0) >= 1, json.dumps(counts))


def phase_take_widened():
    """Dr Chest accepts the widened offer, so the rest of the run measures a held case."""
    api = login(CHEST)
    offered = [c for c in work_of(CHEST) if c["state"] == "offered"]
    check("the widened offer is on his desk", len(offered) == 1,
          json.dumps([(c["state"], c["accession"]) for c in offered]))
    if not offered:
        return
    status, body = api.call("POST", f"/v1/assignments/{offered[0]['assignmentId']}/accept", {})
    check("the at-cap reader accepts the widened offer", status == 200, json.dumps(body)[:120])
    cases = work_of(CHEST)
    check("he now holds two cases on a one-slot queue", len(cases) == 2
          and all(c["state"] == "accepted" for c in cases),
          json.dumps([(c["state"], c["accession"]) for c in cases]))
    status, body = api.call("POST", "/v1/presence/heartbeat", {})
    check("over capacity still reads as present-but-full, never as gone",
          body.get("color") == "amber" and body.get("code") == "at_cap"
          and body.get("openCases", 0) >= body.get("maxQueueSize", 0),
          f"{body.get('color')}/{body.get('code')} {body.get('openCases')}/{body.get('maxQueueSize')}")


def expect_stage2():
    b = clock_for("ACC-ESC-B")
    check("B reached stage 2 (alert_ops) while the widened case stays held",
          b is not None and b["stage"] == 2 and (b.get("holder") or {}).get("state") == "accepted",
          json.dumps({k: b.get(k) for k in ("stage", "elapsedPct", "breached")}) if b else "absent")
    check("alert_ops is recorded, not sent: nothing claims a page went out",
          b is not None and b.get("lastEscalatedAt"), str((b or {}).get("lastEscalatedAt")))


def expect_manual():
    c = clock_for("ACC-ESC-C")
    check("C caught up to stage 3 in one pass", c is not None and c["stage"] == 3,
          json.dumps({k: c.get(k) for k in ("stage", "elapsedPct")}) if c else "absent")
    row = blocked_by("spine")
    if row is None:
        check("C is still listed as unassigned", False, "absent from /v1/dispatch/unassigned")
        return
    study_id = row["studyId"]
    api = owner()
    status, body = api.call("POST", "/v1/assignments", {"studyId": study_id, "clinicianUserId": 999, "reason": "x"})
    check("a non-reader target is refused as not_found", status == 404, f"{status} {json.dumps(body)[:80]}")
    green_id = next((r["userId"] for r in unassigned_panel() if r["name"] == "Dr Green"), None)
    status, body = api.call("POST", "/v1/assignments", {"studyId": study_id, "clinicianUserId": green_id})
    check("a manual assign without a reason is refused", status == 422, f"{status} {json.dumps(body)[:80]}")

    chest_id = next((r["userId"] for r in unassigned_panel() if r["name"] == "Dr Chest"), None)
    check("Dr Chest is on the panel feed", chest_id is not None, str(chest_id))
    status, body = api.call("POST", "/v1/assignments", {
        "studyId": study_id, "clinicianUserId": chest_id, "reason": "spine list full, chest covering tonight",
    })
    check("manual assign to a reader without MRI cover succeeds", status == 201, json.dumps(body)[:160])
    check("the coverage mismatch is reported back, not hidden",
          bool(body.get("warning")) and "mr-spine" in str(body.get("warning")), json.dumps(body.get("warning")))
    status, body = api.call("POST", "/v1/assignments", {
        "studyId": study_id, "clinicianUserId": chest_id, "reason": "double submit",
    })
    check("a second live assignment to the same study is refused", status == 409,
          f"{status} {json.dumps(body)[:80]}")
    c = clock_for("ACC-ESC-C")
    check("the board now names the human who took responsibility",
          c is not None and (c.get("holder") or {}).get("name") == "Dr Chest"
          and (c.get("holder") or {}).get("state") == "accepted",
          json.dumps((c or {}).get("holder")))


def unassigned_panel():
    status, body = owner().call("GET", "/v1/panel")
    if status != 200:
        raise SystemExit(f"/v1/panel: {status} {body}")
    return body.get("panel", [])


def expect_breach():
    b = clock_for("ACC-ESC-B")
    check("B is stamped breached", b is not None and b["breached"] is True,
          json.dumps({k: b.get(k) for k in ("stage", "elapsedPct", "minutesToDeadline", "breached")}) if b else "absent")
    if b:
        check("a breached clock reports negative time left", b["minutesToDeadline"] < 0,
              f"{b['minutesToDeadline']} min")
        # 130% of the window also crosses the 92% rule on the way past the deadline, so
        # the last stage fires in the same pass as the breach stamp.
        check("crossing the deadline does not skip the last stage", b["stage"] == 3, f"stage={b['stage']}")
        check("the breach did not invent a fourth stage", b["stage"] <= 3, f"stage={b['stage']}")
        check("a breached case is still somebody's case",
              (b.get("holder") or {}).get("state") == "accepted", json.dumps(b.get("holder")))
    counts = escalations().get("counts", {})
    check("the board counts the breach", counts.get("breached", 0) >= 1, json.dumps(counts))



def phase_check(expect):
    board = escalations()
    print(f"  escalations: {json.dumps(board.get('counts'))}")
    for row in board.get("late", []):
        print(f"     {row['accession']} {row['priority']} stage={row['stage']} elapsed={row['elapsedPct']}%"
              f" left={row['minutesToDeadline']}min breached={row['breached']}"
              f" holder={json.dumps(row['holder'])}")
    queue = unassigned()
    print(f"  unassigned: {json.dumps(queue.get('counts'))}")
    for row in queue.get("unassigned", []):
        print(f"     study {row['studyId']} {row['priority']} {row['subSpecialty']}"
              f" status={row['status']} stage={row['escalationStage']} widened={row['poolWidened']}"
              f" nearest={json.dumps(row['nearestReader'])}")
    for label, email in (("chest", CHEST), ("green", GREEN), ("paused", PAUSED)):
        cases = work_of(email)
        print(f"  {label}: {json.dumps([(c['state'], c['accession'], c['attemptNo']) for c in cases])}")
        if label == "green":
            # Dr Green is green and idle for the entire run. He must never be handed a
            # chest film or a spine MRI, at any escalation stage, because coverage is not
            # a thing the clock relaxes.
            check("a routable reader outside the coverage was never offered a case",
                  len(cases) == 0, json.dumps([(c["state"], c["accession"]) for c in cases]))
        if label == "paused":
            check("a paused reader was never offered a case", len(cases) == 0,
                  json.dumps([(c["state"], c["accession"]) for c in cases]))
    {"stage1": expect_stage1, "stage2": expect_stage2,
     "manual": expect_manual, "breach": expect_breach}[expect]()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True,
                    choices=["prepare", "presence", "accept", "take-widened", "check"])
    ap.add_argument("--expect", default="stage1", choices=["stage1", "stage2", "manual", "breach"])
    args = ap.parse_args()
    if args.phase == "check":
        phase_check(args.expect)
    else:
        {"prepare": phase_prepare, "presence": phase_presence, "accept": phase_accept,
         "take-widened": phase_take_widened}[args.phase]()
    if FAILED:
        print(f"FAILED {len(FAILED)}: {'; '.join(FAILED)}")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
