#!/usr/bin/env python3
"""P1 acceptance flow, driven over HTTP against a running api.

Login → patient → order → site → agent token → upload three instances → seal.
It exits non-zero on any unexpected status, so CI or an operator gets one answer
instead of reading a page.

    python scripts/validation/run-p1-flow.py --api http://127.0.0.1:3101 \
      --email ops@example.test --password '<bootstrap passphrase>' \
      --dir scripts/validation/out --files img001.dcm,img002.dcm,img003.dcm
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path


class Api:
    def __init__(self, base: str, insecure: bool = False):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        # Deployments serve through Caddy's internal CA, whose root no client
        # machine trusts; --insecure is how a validation script talks to one.
        # It stays opt-in so a public origin keeps real verification.
        ctx = None
        if insecure and self.base.startswith("https:"):
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            urllib.request.HTTPCookieProcessor(self.jar),
        )
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
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try:
                return e.code, json.loads(text)
            except json.JSONDecodeError:
                return e.code, {"raw": text[:200]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:3101")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--files", required=True)
    ap.add_argument("--accession", default="ACC-UPLOAD-0001")
    ap.add_argument("--tenant-id", type=int, default=1)
    ap.add_argument("--insecure", action="store_true",
                    help="accept the deployment's internal CA (Caddy tls internal)")
    args = ap.parse_args()

    api = Api(args.api, insecure=args.insecure)
    failed = []

    def step(name, expect, status, payload):
        ok = status in (expect if isinstance(expect, tuple) else (expect,))
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {status} {json.dumps(payload, default=str)[:220]}")
        if not ok:
            failed.append(name)
        return payload

    status, body = api.call("POST", "/v1/auth/login", {"email": args.email, "password": args.password})
    step("login", 200, status, body)

    status, sess = api.call("GET", "/v1/auth/session")
    step("session", 200, status, sess)

    today = ""
    import datetime
    today = datetime.date.today().strftime("%Y%m%d")

    status, body = api.call("POST", "/v1/patients", {
        "tenantId": args.tenant_id, "mrn": "P-TEST-0001", "fullName": "Ramesh Kumar",
        "gender": "M", "dob": "19780412", "phone": "+91 90000 00000",
    })
    patient = step("create patient", (200, 201), status, body).get("patient", {})
    patient_id = patient.get("id")

    status, body = api.call("POST", "/v1/orders", {
        "tenantId": args.tenant_id, "accessionNumber": args.accession, "patientId": patient_id,
        "modalityCode": "CT", "subSpecialtyCode": "ct-head", "priority": "urgent",
        "scheduledDate": today, "clinicalIndication": "head injury, GCS 13",
        "referringName": "Dr Referrer",
    })
    order = step("create order", (200, 201), status, body).get("order", {})

    status, body = api.call("POST", "/v1/sites", {
        "tenantId": args.tenant_id, "name": "Demo CT (upload test)", "aeTitle": "CT_SCANNER_1",
    })
    if status == 409:
        status, body = 200, {"site": {"id": 1}}
    site = step("register site", (200, 201), status, body).get("site", {"id": 1})

    status, body = api.call("POST", f"/v1/sites/{site.get('id', 1)}/tokens", {"label": "upload-agent", "ttlDays": 30})
    token = step("issue agent token", 201, status, body).get("token")

    # A separate client with no cookie jar. An agent on a modality PC has a token and
    # no session, and reusing this client for the upload steps is how a router that
    # demands a session answered 201 here while the real agent got 401.
    agent = Api(args.api, insecure=args.insecure)
    agent.bearer = token
    status, body = agent.call("POST", "/v1/uploads/batches", {
        "filesExpected": len(args.files.split(",")), "accessionHint": args.accession,
        "modalityHint": "CT", "studyDateHint": today,
    })
    step("agent opens batch with no cookie", 201, status, body)
    batch = body.get("batchId")

    for name in args.files.split(","):
        raw = Path(os.path.join(args.dir, name)).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        status, body = agent.call("PUT", f"/v1/uploads/batches/{batch}/files/{name}",
                                 raw=raw, headers={"X-Content-Sha256": digest, "Content-Type": "application/dicom"})
        step(f"upload {name}", 200, status, body)

    # A wrong digest must be refused, not stored.
    status, body = agent.call("PUT", f"/v1/uploads/batches/{batch}/files/tampered.dcm",
                             raw=b"x" * 200, headers={"X-Content-Sha256": "0" * 64, "Content-Type": "application/dicom"})
    step("reject sha mismatch", 422, status, body)

    status, body = agent.call("POST", f"/v1/uploads/batches/{batch}/seal")
    step("seal batch", 200, status, body)

    # The agent reads back its own batch...
    status, body = agent.call("GET", f"/v1/uploads/batches/{batch}")
    detail = step("agent reads batch", 200, status, body)
    print(f"     batch status={detail.get('batch', {}).get('status')} files={len(detail.get('files', []))}")

    # ...and so does the console, which is a session and must name the tenant.
    status, body = api.call("GET", f"/v1/uploads/batches/{batch}?tenant_id={args.tenant_id}")
    step("console reads batch", 200, status, body)

    status, body = api.call("GET", "/v1/studies?state=linked&limit=5")
    step("list linked studies", 200, status, body)

    print(f"RESULT batch={batch} failures={len(failed)}" + (f" -> {','.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
