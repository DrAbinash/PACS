#!/usr/bin/env python3
"""Dispatch acceptance flow, driven over HTTP against a running api and worker.

Three studies arrive through the real upload channel and five readers are on the
panel, one per failure mode. The expectation is written down before the run so the
result is a verdict rather than a log to be squinted at:

    CT head (STAT)     -> Dr Green    green, covers ct-head, 2 slots
    CT head (routine)  -> Dr Second   green, covers ct-head, 1 slot; Green already
                                      holds one, so the load tie-break moves it
    DX chest (routine) -> Dr Chest    green, chest only — no CT reader may take it
    never              -> Dr Paused   amber, covers everything, paused
    never              -> Dr Gone     red, covers everything, no heartbeat since

Phases are separate commands because the worker runs between them:

  python scripts/validation/run-dispatch-flow.py --phase prepare
  ... worker once / dispatch-once ...
  python scripts/validation/run-dispatch-flow.py --phase presence
  python scripts/validation/run-dispatch-flow.py --phase offers
  python scripts/validation/run-dispatch-flow.py --phase act
  python scripts/validation/run-dispatch-flow.py --phase after
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

API = os.environ.get("DSP_API", "http://127.0.0.1:3101")
OWNER = ("ops@test.local", "testonly-passphrase-42")
PASSWORD = "testonly-passphrase-42"

# email -> the name the assertions look for in the board and the worklist
READERS = {
    "green": "dr-green@test.local",
    "second": "dr-second@test.local",
    "chest": "dr-chest@test.local",
    "paused": "dr-paused@test.local",
    "gone": "dr-gone@test.local",
}

STUDIES = [
    # dir, accession, mrn, name, modality, sub-specialty, order priority
    ("stat", "ACC-DSP-STAT", "P-DSP-1", "Anita Rao", "CT", "ct-head", "stat"),
    ("urg", "ACC-DSP-URG", "P-DSP-2", "Ramesh Kumar", "CT", "ct-head", "urgent"),
    ("dx", "ACC-DSP-DX", "P-DSP-3", "Suresh N", "DX", "dx-chest", "routine"),
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


def work_of(api):
    status, body = api.call("GET", "/v1/my/work")
    if status != 200:
        raise SystemExit(f"/v1/my/work for {api}: {status} {body}")
    return body.get("cases", [])


def phase_prepare():
    owner = login(OWNER[0], OWNER[1])
    today = datetime.date.today().strftime("%Y%m%d")
    token = None
    for sub, acc, mrn, name, modality, specialty, priority in STUDIES:
        status, body = owner.call("POST", "/v1/patients", {
            "tenantId": 1, "mrn": mrn, "fullName": name, "gender": "U", "dob": "19800101",
        })
        check(f"patient {mrn}", status in (200, 201), str(status))
        patient_id = body.get("patient", {}).get("id")

        status, body = owner.call("POST", "/v1/orders", {
            "tenantId": 1, "accessionNumber": acc, "patientId": patient_id,
            "modalityCode": modality, "subSpecialtyCode": specialty, "priority": priority,
            "scheduledDate": today, "clinicalIndication": "dispatch flow",
            "referringName": "Dr Referrer",
        })
        check(f"order {acc}", status in (200, 201), json.dumps(body)[:120])

        status, body = owner.call("POST", "/v1/sites", {
            "tenantId": 1, "name": "Dispatch test site", "aeTitle": "DSP_SCANNER_1",
        })
        if status == 409:
            body = {"site": {"id": 1}}
        site_id = body.get("site", {}).get("id", 1)
        status, body = owner.call("POST", f"/v1/sites/{site_id}/tokens", {"label": "dispatch agent", "ttlDays": 7})
        token = body.get("token")
        check("agent token", status == 201 and bool(token), str(status))

    # Every upload runs on its own cookie-free client: an agent on a modality PC has a
    # token and no session, and a flow that shares the operator's jar proves nothing.
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
    for key, email in READERS.items():
        api = login(email)
        status, body = api.call("POST", "/v1/presence/heartbeat", {})
        check(f"heartbeat {key}", status == 200, f"{body.get('color')}/{body.get('code')}")
        if key == "paused":
            status, body = api.call("PATCH", "/v1/presence", {"state": "paused"})
            check("declare paused", status == 200, str(status))
        if key == "paused":
            status, body = api.call("POST", "/v1/presence/heartbeat", {})
            print(f"     paused after heartbeat: {body.get('color')}/{body.get('code')}")


def phase_offers():
    for key in ("green", "second", "chest", "paused", "gone"):
        cases = work_of(login(READERS[key]))
        print(f"  {key}: {[(c['assignmentId'], c['subSpecialty'], c['priority'], c['state']) for c in cases]}")
    green = work_of(login(READERS["green"]))
    second = work_of(login(READERS["second"]))
    chest = work_of(login(READERS["chest"]))
    paused = work_of(login(READERS["paused"]))
    gone = work_of(login(READERS["gone"]))

    check("green holds one stat CT", len(green) == 1 and green[0]["priority"] == "stat"
          and green[0]["subSpecialty"] == "ct-head", json.dumps(green)[:160])
    check("second holds the other CT", len(second) == 1 and second[0]["subSpecialty"] == "ct-head"
          and second[0]["priority"] != "stat", json.dumps(second)[:160])
    check("chest holds the dx", len(chest) == 1 and chest[0]["subSpecialty"] == "dx-chest",
          json.dumps(chest)[:160])
    check("paused received nothing", len(paused) == 0, f"{len(paused)} cases")
    check("gone received nothing", len(gone) == 0, f"{len(gone)} cases")

    status, body = login(OWNER[0], OWNER[1]).call("GET", "/v1/dispatch/unassigned")
    check("unassigned list answers", status == 200, str(status))
    print(f"     counts={json.dumps(body.get('counts'))} entries={len(body.get('unassigned', []))}")
    for entry in body.get("unassigned", []):
        print(f"     study {entry['studyId']} {entry['priority']} status={entry['status']}"
              f" wouldRouteTo={entry['wouldRouteTo']} because={entry['blockedBecause']}"
              f" nearest={json.dumps(entry['nearestReader'])}")


def phase_act():
    green = login(READERS["green"])
    second = login(READERS["second"])
    chest = login(READERS["chest"])

    green_case = work_of(green)[0]
    status, body = green.call("POST", f"/v1/assignments/{green_case['assignmentId']}/accept", {})
    check("green accepts", status == 200 and bool(body.get("lockToken")),
          json.dumps({k: v for k, v in body.items() if k != "lockToken"})[:160])

    # A second accept must not hand out a second lock on the same case.
    status, body = green.call("POST", f"/v1/assignments/{green_case['assignmentId']}/accept", {})
    check("re-accept refused", status == 409, f"{status} {json.dumps(body)[:80]}")

    # Someone else's assignment reads as not_found rather than confirming it exists.
    status, body = second.call("POST", f"/v1/assignments/{green_case['assignmentId']}/accept", {})
    check("other reader cannot accept", status == 404, f"{status} {json.dumps(body)[:80]}")

    chest_case = work_of(chest)[0]
    status, body = chest.call("POST", f"/v1/assignments/{chest_case['assignmentId']}/decline", {})
    check("decline without a reason refused", status == 422, f"{status} {json.dumps(body)[:80]}")
    status, body = chest.call("POST", f"/v1/assignments/{chest_case['assignmentId']}/decline",
                              {"reason": "in a procedure until 17:00"})
    check("chest declines with a reason", status == 200, json.dumps(body)[:120])

    print(f"     green now holds {len(work_of(green))}, chest now holds {len(work_of(chest))}")


def phase_after():
    green = work_of(login(READERS["green"]))
    chest = work_of(login(READERS["chest"]))
    check("green keeps the accepted case and gained the rotated one",
          len(green) == 2 and sum(1 for c in green if c["state"] == "accepted") == 1
          and sum(1 for c in green if c["state"] == "offered") == 1,
          json.dumps([(c["state"], c["attemptNo"], c["priority"]) for c in green]))
    check("chest released the dx", len(chest) == 0, f"{len(chest)} cases")

    status, body = login(OWNER[0], OWNER[1]).call("GET", "/v1/dispatch/unassigned")
    blocked = [e for e in body.get("unassigned", []) if e["status"] == "blocked"]
    print(f"     counts={json.dumps(body.get('counts'))}")
    for entry in blocked:
        print(f"     blocked study {entry['studyId']} because={entry['blockedBecause']}"
              f" nearest={json.dumps(entry['nearestReader'])}")
    check("the declined dx is blocked with the rotation reason",
          any("already_offered" in (e["nearestReader"] or {}).get("missing", []) for e in blocked),
          json.dumps([e["nearestReader"] for e in blocked])[:200])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True,
                    choices=["prepare", "presence", "offers", "act", "after"])
    args = ap.parse_args()
    {"prepare": phase_prepare, "presence": phase_presence, "offers": phase_offers,
     "act": phase_act, "after": phase_after}[args.phase]()
    if FAILED:
        print(f"FAILED {len(FAILED)}: {'; '.join(FAILED)}")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
