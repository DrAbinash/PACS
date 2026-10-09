#!/usr/bin/env python3
"""The viewer, driven over HTTP: who may open a case, and what they get.

Routing a case to a reader is only half of it — a reader who accepts a study has to be
able to look at it. This checks the part that carries patient data, because that is the
part where an authorisation mistake is silent: a proxy that returns pixels for anybody
who knows an id looks exactly like a viewer that works.

Three studies matter here:

    ACC-VIEW-1  CT head, 64x64 gradient, three slices, WindowCenter 40 / WindowWidth 400
                and RescaleIntercept -1024 — the shape a real CT carries.
    ACC-ESC-A   held by Dr Chest (from run-escalation-flow.py).
    anyone else must not be able to open either.

Phases:

  python scripts/validation/run-view-flow.py --phase prepare     # order + upload
  ... worker once, wait for Orthanc to call it stable, worker once, dispatch-once ...
  python scripts/validation/run-view-flow.py --phase accept      # Green takes the CT
  python scripts/validation/run-view-flow.py --phase check

The pixel assertions are arithmetic, not a hash: the fixture generator writes
`400 + ((x*y + instance_number*37) % 900)`, plus 700 inside a disc, so a slice can be
verified against the file that made it rather than against whatever came out last time.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import sys
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "flow", Path("scripts/validation/run-escalation-flow.py").resolve())
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

API = flow.API
OWNER = flow.OWNER
GREEN = flow.GREEN
CHEST = flow.CHEST
VIEW = ("view", "ACC-VIEW-1", "P-VIEW-1", "Deepa Menon", "CT", "ct-head", "urgent")
DISC = 60
SIDE = 64


def value(x, y, number):
    v = 400 + ((x * y + number * 37) % 900)
    if (x - SIDE // 2) ** 2 + (y - SIDE // 2) ** 2 < DISC:
        v += 700
    return min(v, 4095)


def study_id_for(email, accession):
    for case in flow.work_of(email):
        if case["accession"] == accession:
            return case["studyId"], case["assignmentId"]
    return None, None


def phase_prepare():
    api = flow.owner()
    sub, acc, mrn, name, modality, specialty, priority = VIEW
    today = datetime.date.today().strftime("%Y%m%d")
    status, body = api.call("POST", "/v1/patients", {
        "tenantId": 1, "mrn": mrn, "fullName": name, "gender": "F", "dob": "19720311",
    })
    print("patient", status)
    patient_id = body.get("patient", {}).get("id")
    status, body = api.call("POST", "/v1/orders", {
        "tenantId": 1, "accessionNumber": acc, "patientId": patient_id,
        "modalityCode": modality, "subSpecialtyCode": specialty, "priority": priority,
        "scheduledDate": today, "clinicalIndication": "viewer flow",
        "referringName": "Dr Referrer",
    })
    print("order", status, json.dumps(body)[:100])

    status, body = api.call("POST", "/v1/sites", {
        "tenantId": 1, "name": "Escalation test site", "aeTitle": "ESC_SCANNER_1",
    })
    site_id = 1 if status == 409 else body.get("site", {}).get("id", 1)
    status, body = api.call("POST", f"/v1/sites/{site_id}/tokens", {"label": "viewer agent", "ttlDays": 7})
    token = body.get("token")
    flow.check("agent token", status == 201 and bool(token), str(status))

    directory = Path("scripts/validation/out") / sub
    files = sorted(p.name for p in directory.glob("*.dcm"))
    flow.check("three instances generated", len(files) == 3, str(files))
    agent = flow.Api(API)
    agent.bearer = token
    status, body = agent.call("POST", "/v1/uploads/batches", {
        "filesExpected": len(files), "accessionHint": acc, "modalityHint": modality,
        "studyDateHint": today,
    })
    batch = body.get("batchId")
    for name in files:
        raw = (directory / name).read_bytes()
        status, _ = agent.call("PUT", f"/v1/uploads/batches/{batch}/files/{name}", raw=raw,
                               headers={"X-Content-Sha256": hashlib.sha256(raw).hexdigest(),
                                        "Content-Type": "application/dicom"})
        flow.check(f"put {name}", status == 200, str(status))
    status, body = agent.call("POST", f"/v1/uploads/batches/{batch}/seal", {})
    flow.check("seal", status == 200, json.dumps(body)[:120])


def phase_accept():
    cases = flow.work_of(GREEN)
    held = [c for c in cases if c["accession"] == VIEW[1]]
    flow.check("the CT reached the reader who covers heads", len(held) == 1,
               json.dumps([(c["state"], c["accession"]) for c in cases]))
    if not held:
        return
    status, body = flow.login(GREEN).call(
        "POST", f"/v1/assignments/{held[0]['assignmentId']}/accept", {})
    flow.check("green accepts the CT", status == 200, json.dumps(body)[:120])


def frame_bytes(api, study_id, pk, index=0):
    """A plain GET with the session cookie, because the success answer is not JSON."""
    cookie = api_cookie(api)
    hdrs = {"Cookie": cookie} if cookie else {}
    req = urllib.request.Request(f"{API}/v1/view/{study_id}/instances/{pk}/frames/{index}",
                                 headers=hdrs, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def api_cookie(api):
    for cookie in api.jar:
        if cookie.name == "telrad_session":
            return f"{cookie.name}={cookie.value}"
    return None


def phase_check():
    green = flow.login(GREEN)
    study_id, _ = study_id_for(GREEN, VIEW[1])
    flow.check("green holds the CT by study id", study_id is not None, str(study_id))
    if study_id is None:
        return

    status, d = green.call("GET", f"/v1/view/{study_id}")
    flow.check("holder opens the case", status == 200, str(status))
    series = d.get("series", [])
    print(f"     study={json.dumps(d.get('study'))[:220]}")
    print(f"     series={[(s['index'], s['description'], s['count']) for s in series]}"
          f" windowing={d.get('windowing')} pixelFormat={d.get('pixelFormat')}")
    flow.check("the node's series came back", len(series) >= 1 and series[0]["count"] == 3,
               f"{len(series)} series")
    flow.check("the patient travels with the case", bool(d.get("study", {}).get("patient", {}).get("name")),
               json.dumps(d.get("study", {}).get("patient")))
    flow.check("the answer says where the window is computed", d.get("windowing") == "client",
               str(d.get("windowing")))
    instances = series[0]["instances"] if series else []

    status, meta = green.call("GET", f"/v1/view/{study_id}/instances/{instances[0]}")
    flow.check("instance tags", status == 200 and meta.get("rows") == SIDE
               and meta.get("columns") == SIDE and meta.get("bitsStored") == 12,
               json.dumps({k: meta.get(k) for k in ("rows", "columns", "bitsStored", "windowCenter",
                                                    "windowWidth", "rescaleIntercept",
                                                    "pixelRepresentation", "instanceNumber")}))

    status, headers, body = frame_bytes(green, study_id, instances[0])
    count = int(headers.get("X-Telrad-Pixel-Count", "0"))
    flow.check("the frame is raw 16-bit pixels", status == 200
               and headers.get("X-Telrad-Pixel-Format") == "int16-le"
               and len(body) == count * 2 and count == SIDE * SIDE,
               f"{status} {len(body)}B count={count}")
    flow.check("pixels are not cached", headers.get("Cache-Control") == "no-store",
               str(headers.get("Cache-Control")))
    import array
    values = array.array("h")
    values.frombytes(body)
    number = meta.get("instanceNumber") or 1
    wanted = [value(x % SIDE, x // SIDE, number) for x in range(SIDE * SIDE)]
    mismatches = sum(1 for a, b in zip(values, wanted) if a != b)
    flow.check("the bytes are the pixels the fixture wrote", mismatches == 0,
               f"{mismatches} of {len(wanted)} differ; got {values[:3]} expected {wanted[:3]}")

    second = frame_bytes(green, study_id, instances[1])[2]
    flow.check("two slices of one study are two different images", second != body,
               f"{len(second)}B vs {len(body)}B")

    chest = flow.login(CHEST)
    chest_held, _ = study_id_for(CHEST, "ACC-ESC-A")
    status, body = chest.call("GET", f"/v1/view/{study_id}")
    flow.check("another tenant's reader cannot open it", status == 403
               and body.get("error") == "not_your_case", f"{status} {json.dumps(body)[:120]}")
    if chest_held is not None:
        status, _ = chest.call("GET", f"/v1/view/{chest_held}")
        flow.check("the chest reader can open the case they hold", status == 200, str(status))
        # Green's instance, on Chest's session: the id is real, the authorisation is not.
        status, headers, body = frame_bytes(chest, chest_held, instances[0])
        detail = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
        flow.check("an instance from somebody else's study is refused",
                   status == 404 and "not_in_this_study" in detail,
                   f"{status} {detail[:120]}")

    outsider = flow.Api(API)
    status, _, _ = frame_bytes(outsider, study_id, instances[0])
    flow.check("no session, no pixels", status == 401, str(status))

    status, body = green.call("GET", f"/v1/view/{study_id}/instances/not-a-uuid")
    flow.check("a malformed node id is refused before the node is asked", status == 400
               and body.get("error") == "bad_id", f"{status} {json.dumps(body)[:120]}")
    status, body = green.call("GET", f"/v1/view/{study_id}/instances/{instances[0]}/frames/9999")
    flow.check("a frame index outside the range is refused", status == 400
               and body.get("error") == "bad_frame_index", f"{status} {json.dumps(body)[:120]}")

    operator = flow.owner()
    status, _ = operator.call("GET", f"/v1/view/{study_id}")
    flow.check("an operator can open a case they do not hold", status == 200, str(status))
    status, entries = operator.call("GET", "/v1/audit/latest?limit=20")
    actions = [e["action"] for e in entries.get("entries", [])]
    flow.check("opening a case is audited", "view.open" in actions, json.dumps(actions[:8]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=["prepare", "accept", "check"])
    args = ap.parse_args()
    {"prepare": phase_prepare, "accept": phase_accept, "check": phase_check}[args.phase]()
    if flow.FAILED:
        print(f"FAILED {len(flow.FAILED)}: {'; '.join(flow.FAILED)}")
        return 1
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
