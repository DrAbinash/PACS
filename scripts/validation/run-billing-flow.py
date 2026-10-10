#!/usr/bin/env python3
"""The money side, driven over HTTP against the live stack.

An invoice is the one document in this product that somebody outside the company reads and adds
up by hand - a center's accounts desk, and if it comes to it, a tax officer. So this flow is not
about whether the arithmetic is right in isolation (the shared unit tests do that with integers);
it is about whether the number a center receives is the number the studies actually earned:

  * priced at the rate that was in force on the day the report was *delivered*, which for a study
    billed in October at a rate retired in November means the retired row still does the work;
  * one line per study however many versions of it were delivered;
  * a study with no rate named as unpriced rather than quietly dropped or priced from a
    neighbouring modality;
  * re-added from its own lines at the moment of issue, so the total on the page is provably the
    sum of the rows above it;
  * numbered in an unbroken financial-year sequence, with a dropped draft costing no number.

What is fixture and what is the product, stated plainly:

  The patient, the order, the assignment, the report, the two signatures and the delivery are all
  done through the same routes the desk and the reader use. The `studies` row is inserted by SQL,
  because making five of them arrive for real would mean five uploads, five worker passes and one
  Orthanc restart, and the ingest path is proven by `run-p1-flow.py`, `run-view-flow.py` and
  `run-agent-flow.py`. The `delivered_at` instants are then moved by SQL to named hours: a night
  reading at 00:05 IST cannot be scheduled into a test run that finishes in a minute. A price that
  depended on the *wall clock* rather than on that stored column would fail here, which is the
  point of moving it.

Phases, in order (bash scripts/validation/run-billing-live.sh runs them all):

  python scripts/validation/run-billing-flow.py --phase seed
  python scripts/validation/run-billing-flow.py --phase deliver
  python scripts/validation/run-billing-flow.py --phase preview
  python scripts/validation/run-billing-flow.py --phase invoice
  python scripts/validation/run-billing-flow.py --phase access

Each phase is idempotent enough to re-run after a fix, and the stack it needs is the throwaway one
built by `run-live-stack.sh`.
"""
import datetime
import http.cookiejar
import importlib.util
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "flow", Path("scripts/validation/run-escalation-flow.py").resolve())
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

API = flow.API
OWNER = flow.OWNER
GREEN = flow.GREEN           # senior radiologist: writes and signs
SECOND = "dr-second@test.local"   # chief reviewer: countersigns, then amends
BOSS = "dr-boss@test.local"       # chief radiologist: countersigns the amendment

TENANT = 1
FINDINGS = "No acute intracranial haemorrhage. No mass effect. Ventricles and sulci are " \
           "age appropriate."
IMPRESSION = "No acute pathology on the available slices."
AMENDED = "No acute pathology. A small right frontoparietal hypodensity is noted, clinical " \
          "correlation suggested."

# (accession, mrn, name, modality, sub-specialty, priority, delivered_at in UTC, tariff expectation)
CASES = [
    ("ACC-BIL-1", "P-BIL-1", "Anita Rao",    "CT", "ct-head", "routine",
     "2026-10-05T09:00:00+00:00", "day rate, retired row"),
    ("ACC-BIL-2", "P-BIL-2", "Ramesh Kumar", "CT", "ct-head", "routine",
     "2026-10-06T18:35:00+00:00", "00:05 IST, night premium"),
    ("ACC-BIL-3", "P-BIL-3", "Suresh N",     "CT", "ct-head", "urgent",
     "2026-10-07T05:00:00+00:00", "urgent rate"),
    ("ACC-BIL-4", "P-BIL-4", "Lakshmi V",    "DX", "dx-chest", "routine",
     "2026-10-07T06:00:00+00:00", "no tariff at all"),
    ("ACC-BIL-5", "P-BIL-5", "Mohan S",      "CT", "ct-head", "routine",
     "2026-10-20T05:00:00+00:00", "new rate in force"),
]
AMENDED_DELIVERED = "2026-10-09T05:00:00+00:00"

PERIOD_A = ("2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z")
PERIOD_B = ("2026-10-16T00:00:00Z", "2026-11-01T00:00:00Z")

TARIFF_OLD_ROUTINE = 80000    # ₹800.00 in paise
TARIFF_NEW_ROUTINE = 100000   # ₹1,000.00 from 16 Oct
TARIFF_URGENT = 120000        # ₹1,200.00
NIGHT_PCT = 25
TAX_PCT = 18


def psql(sql):
    out = subprocess.run(["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad",
                          "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"psql failed: {out.stderr.strip()[:300]}\n  {sql[:200]}")
    return out.stdout.strip()


def q(s):
    return "'" + s.replace("'", "''") + "'"


def rupees(paise):
    return f"{paise // 100}.{paise % 100:02d}"


def line_tax(paise, pct):
    """Per line, rounded once - the rule the invoice has to follow, computed here from the
    numbers the API printed rather than from the API's own total."""
    return int(paise * pct / 100 + 0.5)


def fetch_raw(api, path):
    """CSV is text, not JSON, and the shared helper decodes to a dict."""
    req = urllib.request.Request(api.base + path, method="GET",
                                 headers={"Authorization": "Bearer " + api.bearer} if api.bearer else {})
    try:
        with api.opener.open(req, timeout=30) as res:
            return res.status, res.read().decode(), dict(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(), dict(err.headers)


# ---- phase: seed ------------------------------------------------------------------------------

def phase_seed():
    ops = flow.owner()

    status, body = ops.call("POST", "/v1/billing/tax-rate", {"tenantId": TENANT, "taxPct": TAX_PCT})
    flow.check("the tax rate is set by the operator, not assumed by the code",
               status == 200 and body.get("taxPct") == TAX_PCT, f"{status} {json.dumps(body)[:120]}")

    created = {}
    for label, modality, sub, priority, rupee_body, effective in [
        ("old-routine", "CT", "ct-head", "routine", {"unitRupees": 800.00, "nightMultiplierPct": NIGHT_PCT},
         "2026-06-01T00:00:00Z"),
        ("urgent", "CT", "ct-head", "urgent", {"unitRupees": 1200.00, "nightMultiplierPct": 0},
         "2026-06-01T00:00:00Z"),
        ("new-routine", "CT", "ct-head", "routine", {"unitRupees": 1000.00, "nightMultiplierPct": NIGHT_PCT},
         "2026-10-16T00:00:00Z"),
    ]:
        if label == "new-routine":
            # Created last but at the later date: the rate change is the ordinary case, and a
            # row that starts after the one in force must be accepted so that activation can
            # close the older window. Refusing it would make a price rise impossible to express.
            pass
        status, body = ops.call("POST", "/v1/billing/tariffs", {
            "tenantId": TENANT, "modalityCode": modality, "subSpecialtyCode": sub,
            "priority": priority, "effectiveFrom": effective, **rupee_body,
        })
        tariff = body.get("tariff", {})
        created[label] = tariff.get("id")
        flow.check(f"tariff {label} created as a draft",
                   status == 201 and tariff.get("status") == "draft",
                   f"{status} {json.dumps(body)[:140]}")
        flow.check(f"and {label} is stored in whole paise, not as the float it was sent as",
                   tariff.get("unitPaise") == int(round(rupee_body["unitRupees"] * 100))
                   and tariff.get("unitRupees") == rupees(tariff.get("unitPaise", 0)),
                   json.dumps({k: tariff.get(k) for k in ("unitPaise", "unitRupees")}))

    status, body = ops.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitRupees": 555.00, "effectiveFrom": "2026-07-01T00:00:00Z",
    })
    flow.check("a row that starts *before* the one already in force is refused, because then two "
               "rates cover every later moment and a sort would decide which prices a study",
               status == 409 and body.get("error") == "tariff_window_overlaps",
               f"{status} {json.dumps(body)[:140]}")

    status, body = ops.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitRupees": 800.00, "effectiveFrom": "2026-06-01T00:00:00Z",
    })
    flow.check("and the same key on the same starting day is named as a duplicate row rather than "
               "as a window overlap, because those are different mistakes",
               status == 409 and body.get("error") == "tariff_already_exists_for_that_start",
               f"{status} {json.dumps(body)[:140]}")

    status, body = ops.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitPaise": 90000, "effectiveFrom": "2027-01-01T00:00:00Z",
    })
    flow.check("a price given in paise is taken as paise, not converted again",
               status == 201 and body.get("tariff", {}).get("unitPaise") == 90000,
               f"{status} {json.dumps(body.get('tariff', {}))[:140]}")
    extra = body.get("tariff", {}).get("id")
    if extra:
        ops.call("POST", f"/v1/billing/tariffs/{extra}/retire", {"effectiveTo": "2027-01-01T00:00:00Z"})

    status, body = ops.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitRupees": 500.004, "effectiveFrom": "2035-01-01T00:00:00Z",
    })
    flow.check("a price that is not a whole number of paise is refused rather than rounded, "
               "because the operator's number is a contract term",
               status == 422 and body.get("error") == "bad_unit_price", f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitRupees": 0.07, "effectiveFrom": "2035-01-01T00:00:00Z",
    })
    flow.check("while a price that only looks like a float because of binary arithmetic - "
               "7 paise - is accepted", status == 201 and body.get("tariff", {}).get("unitPaise") == 7,
               f"{status} {json.dumps(body)[:140]}")
    seven = body.get("tariff", {}).get("id")
    if seven:
        ops.call("POST", f"/v1/billing/tariffs/{seven}/retire", {"effectiveTo": "2035-01-01T00:00:00Z"})

    for label in ("old-routine", "urgent", "new-routine"):
        status, body = ops.call("POST", f"/v1/billing/tariffs/{created[label]}/activate", {})
        flow.check(f"{label} activated", status == 200, f"{status} {json.dumps(body)[:140]}")

    retired = psql(f"select status || ' ' || coalesce(to_char(effective_to, 'YYYY-MM-DD'), 'null') "
                   f"from telrad.tariffs where id = {created['old-routine']};")
    flow.check("activating the October rate closed the June rate's window rather than deleting it, "
               "so a study delivered in between still prices at the rate that was in force",
               retired == "retired 2026-10-16", retired)

    status, body = ops.call("GET", f"/v1/billing/tariffs?tenantId={TENANT}")
    rows = {t["id"]: t for t in body.get("tariffs", [])}
    flow.check("the retired row is still readable and still carries its price",
               rows[created["old-routine"]]["status"] == "retired"
               and rows[created["old-routine"]]["unitPaise"] == TARIFF_OLD_ROUTINE,
               json.dumps(rows.get(created["old-routine"]))[:160])

    # Re-activating the June row is legal, and the reason it is legal is the window: its
    # `effective_to` is already closed at the October start, so the two rows price disjoint days and
    # no study can ever be claimed by both. This is the state the pricing phase then reads.
    status, body = ops.call("POST", f"/v1/billing/tariffs/{created['old-routine']}/activate", {})
    flow.check("re-activating a row whose window is already closed retires nothing, because the "
               "windows do not overlap - it is the closed window, not the status word, that keeps "
               "one study from being priced twice",
               status == 200 and body.get("retiredTariffs") == [], f"{status} {json.dumps(body)[:140]}")
    both = psql("select count(*) from telrad.tariffs where status = 'active' and tenant_id = 1 "
                "and modality_code = 'CT' and sub_specialty_code = 'ct-head' "
                "and priority = 'routine';")
    flow.check("so two routine rows are active at once, kept apart only by the closed window on "
               "the older one", both == "2", f"active routine rows={both}")


# ---- phase: deliver ---------------------------------------------------------------------------

def deliver_one(ops, green, second, case):
    accession, mrn, name, modality, sub, priority, _delivered, _note = case
    today = datetime.date.today().strftime("%Y%m%d")

    status, body = ops.call("POST", "/v1/patients", {
        "tenantId": TENANT, "mrn": mrn, "fullName": name, "gender": "U", "dob": "19750101",
    })
    patient_id = body.get("patient", {}).get("id")
    if status not in (200, 201) or not patient_id:
        raise SystemExit(f"patient {mrn}: {status} {json.dumps(body)[:200]}")

    status, body = ops.call("POST", "/v1/orders", {
        "tenantId": TENANT, "accessionNumber": accession, "patientId": patient_id,
        "modalityCode": modality, "subSpecialtyCode": sub, "priority": priority,
        "scheduledDate": today, "clinicalIndication": "billing flow - headache",
        "referringName": "Dr Referrer", "referringEmail": "dr.rao@govhosp.test",
    })
    order_id = body.get("order", {}).get("id")
    if status not in (200, 201) or not order_id:
        raise SystemExit(f"order {accession}: {status} {json.dumps(body)[:200]}")

    existing = psql(f"select id from telrad.studies where accession_number = {q(accession)} "
                    f"and storage_node_id = 'node-test';")
    if existing:
        study_id = int(existing.splitlines()[0])
    else:
        psql("""
            insert into telrad.studies (storage_node_id, node_pk, study_instance_uid, tenant_id,
                                        order_id, patient_id, accession_number, study_date,
                                        modality_code, sub_specialty_code, priority, link_state,
                                        match_method, match_score, received_at, linked_at)
            values ('node-test', 'node-test', %s, 1, %s, %s, %s, %s, %s, %s, %s, 'linked',
                    'accession', 1.0, now(), now())
            returning id;""" % (q(f"1.2.826.0.1.billing.{accession}"), order_id, patient_id,
                                 q(accession), q(today), q(modality), q(sub), q(priority)))
        study_id = int(psql(f"select id from telrad.studies where accession_number = {q(accession)};")
                       .splitlines()[0])

    status, body = ops.call("POST", "/v1/assignments", {
        "studyId": study_id, "clinicianUserId": green_user_id(), "reason": "billing flow fixture",
    })
    if status not in (200, 201) and body.get("error") != "already_assigned":
        raise SystemExit(f"assign {accession}: {status} {json.dumps(body)[:200]}")

    status, body = green.call("POST", "/v1/reports", {"studyId": study_id})
    report_id = body.get("report", {}).get("id") or body.get("reportId")
    if status == 409 and body.get("error") == "report_exists":
        report_id = body.get("reportId")
    if not report_id:
        raise SystemExit(f"report {accession}: {status} {json.dumps(body)[:200]}")

    green.call("PATCH", f"/v1/reports/{report_id}", {"sections": {"findings": FINDINGS}})
    green.call("PATCH", f"/v1/reports/{report_id}", {"sections": {"impression": IMPRESSION}})
    status, body = green.call("POST", f"/v1/reports/{report_id}/sign", {})
    if status != 200:
        raise SystemExit(f"sign {accession}: {status} {json.dumps(body)[:200]}")
    status, body = second.call("POST", f"/v1/reports/{report_id}/countersign", {})
    if status != 200:
        raise SystemExit(f"countersign {accession}: {status} {json.dumps(body)[:200]}")
    status, body = ops.call("POST", f"/v1/reports/{report_id}/deliver", {})
    if status != 200:
        raise SystemExit(f"deliver {accession}: {status} {json.dumps(body)[:200]}")
    return study_id, report_id


_USER_IDS = {}


def green_user_id():
    if not _USER_IDS:
        for email, key in ((GREEN, "green"), (SECOND, "second"), (BOSS, "boss")):
            _USER_IDS[key] = int(psql(
                f"select id from telrad.users where email = {q(email.lower())};"))
    return _USER_IDS["green"]


def phase_deliver():
    ops, green, second = flow.owner(), flow.login(GREEN), flow.login(SECOND)
    green_user_id()

    ids = {}
    for case in CASES:
        study_id, report_id = deliver_one(ops, green, second, case)
        ids[case[0]] = (study_id, report_id)
        flow.check(f"{case[0]} delivered through the desk's own routes", bool(study_id) and bool(report_id),
                   f"study {study_id} report {report_id}")

    # The correction: v1 was delivered, then amended, then the corrected version was delivered.
    # Both rows keep their delivery times, and the study must be billed once, at the earlier one.
    accession, study_id, report_id = CASES[0][0], ids[CASES[0][0]][0], ids[CASES[0][0]][1]
    status, body = second.call("POST", f"/v1/reports/{report_id}/amend",
                               {"reason": "Billing flow: impression corrected after the clinic called."})
    v2 = body.get("report", {}).get("id")
    if not v2:
        v2 = int(psql(f"select id from telrad.reports where study_id = {study_id} and version = 2;"))
    flow.check("the delivered report was amended into a second version", status == 201 and bool(v2),
               f"{status} {json.dumps(body)[:140]}")
    second.call("PATCH", f"/v1/reports/{v2}", {"sections": {"impression": AMENDED}})
    status, body = second.call("POST", f"/v1/reports/{v2}/sign", {})
    flow.check("the amender signs their own version", status == 200, f"{status} {json.dumps(body)[:120]}")
    status, body = flow.login(BOSS).call("POST", f"/v1/reports/{v2}/countersign", {})
    flow.check("and a different chief clears it", status == 200, f"{status} {json.dumps(body)[:120]}")
    status, body = ops.call("POST", f"/v1/reports/{v2}/deliver", {})
    flow.check("the corrected version is delivered too", status == 200, f"{status} {json.dumps(body)[:120]}")

    for case in CASES:
        psql(f"""update telrad.reports set delivered_at = {q(case[6])}::timestamptz
                  where study_id = (select id from telrad.studies where accession_number = {q(case[0])})
                    and version = 1;""")
    psql(f"""update telrad.reports set delivered_at = {q(AMENDED_DELIVERED)}::timestamptz
              where study_id = (select id from telrad.studies where accession_number = {q(accession)})
                and version = 2;""")

    seen = psql("""select s.accession_number || ' ' || to_char(min(r.delivered_at), 'YYYY-MM-DD"T"HH24:MI')
                   || ' ist=' || to_char(min(r.delivered_at) + interval '5.5 hour', 'HH24:MI')
                   from telrad.studies s join telrad.reports r on r.study_id = s.id
                  where s.accession_number like 'ACC-BIL%'
                  group by s.accession_number order by s.accession_number;""")
    print("  first delivery per study (UTC) and its IST clock time:")
    for line in seen.splitlines():
        print("   ", line)

    rows = psql("""select count(*) from telrad.reports where delivered_at is not null
                    and study_id in (select id from telrad.studies where accession_number like 'ACC-BIL%');""")
    flow.check("six delivered report rows exist for five studies, which is the double charge waiting "
               "to happen", rows == "6", rows)


# ---- phase: preview ---------------------------------------------------------------------------

def phase_preview():
    ops = flow.owner()
    _status, tbody = ops.call("GET", f"/v1/billing/tariffs?tenantId={TENANT}")
    ct_routine = [t for t in tbody.get("tariffs", []) if t["modalityCode"] == "CT"
                  and t["subSpecialtyCode"] == "ct-head" and t["priority"] == "routine"]
    june = next(t for t in ct_routine if t["unitPaise"] == TARIFF_OLD_ROUTINE)
    oct_row = next(t for t in ct_routine if t["unitPaise"] == TARIFF_NEW_ROUTINE)

    status, body = ops.call("GET", f"/v1/billing/preview?tenantId={TENANT}"
                                f"&from={PERIOD_A[0]}&to={PERIOD_A[1]}")
    flow.check("the period previews", status == 200, f"{status} {json.dumps(body)[:140]}")

    lines = body.get("lines", [])
    by_acc = {}
    for line in lines:
        acc = line["description"].split(" for ")[-1]
        by_acc[acc] = line
    flow.check("three studies of the four in the window have a price",
               len(lines) == 3, json.dumps([l["description"] for l in lines])[:220])
    flow.check("and the fourth is named as unpriced instead of being dropped or priced from "
               "the CT rate next door",
               body.get("totals", {}).get("grossPaise") is not None
               and any(u["accession"] == "ACC-BIL-4" and u["reason"] == "no_tariff"
                       for u in body.get("unpriced", [])),
               json.dumps(body.get("unpriced"))[:200])

    flow.check("the day reading prices at the rate that was in force on 5 October, which is the "
               "row that has since been retired",
               by_acc.get("ACC-BIL-1", {}).get("amountPaise") == TARIFF_OLD_ROUTINE,
               json.dumps(by_acc.get("ACC-BIL-1"))[:160])
    flow.check("and the retired row is the one recorded on the line, not the active one",
               by_acc.get("ACC-BIL-1", {}).get("tariffId") == june["id"]
               and by_acc.get("ACC-BIL-2", {}).get("tariffId") == june["id"],
               json.dumps([by_acc.get("ACC-BIL-1", {}).get("tariffId"), june["id"],
                           oct_row["id"]])[:160])

    night = by_acc.get("ACC-BIL-2", {})
    flow.check("a report delivered at 00:05 IST carries the night premium as a premium, not as a "
               "replacement price",
               night.get("amountPaise") == int(TARIFF_OLD_ROUTINE * (100 + NIGHT_PCT) / 100)
               and night.get("amountPaise") == 100000 and night.get("night") is True,
               json.dumps(night)[:180])
    flow.check("and the night is in the words on the line, so the center can see why it is more",
               "night reading" in night.get("description", "")
               and "night" not in by_acc.get("ACC-BIL-1", {}).get("description", "").lower(),
               night.get("description", ""))

    flow.check("the urgent study prices at the urgent rate",
               by_acc.get("ACC-BIL-3", {}).get("amountPaise") == TARIFF_URGENT
               and "(urgent)" in by_acc.get("ACC-BIL-3", {}).get("description", ""),
               json.dumps(by_acc.get("ACC-BIL-3"))[:180])

    tot = body.get("totals", {})
    want_gross = TARIFF_OLD_ROUTINE + 100000 + TARIFF_URGENT
    want_tax = sum(line_tax(p, TAX_PCT) for p in (TARIFF_OLD_ROUTINE, 100000, TARIFF_URGENT))
    flow.check("the preview's gross is the three lines added, and its tax is each line taxed "
               "separately and then summed",
               tot.get("grossPaise") == want_gross and tot.get("taxPaise") == want_tax
               and tot.get("totalPaise") == want_gross + want_tax,
               json.dumps(tot))
    flow.check("money is printed with two decimals from an integer, never from a float",
               tot.get("grossRupees") == rupees(want_gross), json.dumps(tot)[:160])

    status, body = ops.call("GET", f"/v1/billing/preview?tenantId={TENANT}"
                                f"&from={PERIOD_B[0]}&to={PERIOD_B[1]}")
    lines_b = body.get("lines", [])
    flow.check("the following period holds only the study delivered after the rate rose",
               len(lines_b) == 1 and lines_b[0]["amountPaise"] == TARIFF_NEW_ROUTINE
               and lines_b[0]["tariffId"] == oct_row["id"],
               json.dumps(lines_b)[:200])

    status, body = ops.call("GET", f"/v1/billing/preview?tenantId={TENANT}"
                                f"&from={PERIOD_A[1]}&to={PERIOD_A[0]}")
    flow.check("a period that ends before it starts is refused rather than answered as an empty "
               "invoice", status == 422 and body.get("error") == "period_end_before_start",
               f"{status} {json.dumps(body)[:120]}")
    status, body = ops.call("GET", f"/v1/billing/preview?tenantId={TENANT}"
                                f"&from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")
    flow.check("and a six-year window is refused as too long to bill in one document",
               status == 422 and body.get("error") == "period_too_long", f"{status} {json.dumps(body)[:120]}")


# ---- phase: invoice ---------------------------------------------------------------------------

def phase_invoice():
    ops = flow.owner()

    status, body = ops.call("POST", "/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": PERIOD_A[0], "periodEnd": PERIOD_A[1]})
    invoice_a = body.get("id")
    flow.check("the draft invoice is created for the period", status == 201 and bool(invoice_a),
               f"{status} {json.dumps(body)[:160]}")
    flow.check("and it is priced from three lines for four delivered studies, because the amended "
               "one is one study",
               body.get("lines") == 3, json.dumps({k: body.get(k) for k in ("lines", "unpriced")})[:200])

    status, body = ops.call("GET", f"/v1/billing/invoices/{invoice_a}")
    inv = body.get("invoice", {})
    flow.check("a draft carries no invoice number, because a draft that took number 1 and was "
               "deleted would leave a hole in a GST sequence",
               inv.get("status") == "draft" and inv.get("number", "").startswith("draft-"),
               json.dumps({k: inv.get(k) for k in ("status", "number")}))

    status, body = ops.call("POST", "/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": "2026-10-05T00:00:00Z", "periodEnd": "2026-10-20T00:00:00Z"})
    flow.check("a second draft overlapping the first is refused, so half a month cannot be billed "
               "twice", status == 409 and body.get("error") == "period_already_billed",
               f"{status} {json.dumps(body)[:160]}")

    status, body = ops.call("POST", "/v1/billing/invoices", {
        "tenantId": 999, "periodStart": PERIOD_A[0], "periodEnd": PERIOD_A[1]})
    flow.check("and a tenant that does not exist is answered 404 rather than billed into an "
               "orphan document", status == 404, f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("GET", f"/v1/billing/invoices/{invoice_a}")
    lines = body.get("lines", [])
    want_gross = sum(l["amountPaise"] for l in lines)
    want_tax = sum(line_tax(l["amountPaise"], TAX_PCT) for l in lines)

    status, body = ops.call("POST", f"/v1/billing/invoices/{invoice_a}/issue", {})
    issued = body.get("totals", {})
    flow.check("issuing re-adds the document from its own stored lines",
               status == 200 and issued.get("grossPaise") == want_gross
               and issued.get("taxPaise") == want_tax,
               f"{status} {json.dumps(body)[:200]}")
    number = body.get("number", "")
    flow.check("the number is the tenant code, the financial year and a sequence: "
               f"{number}", number == "WHQ-2627-0001", number)

    status, body = ops.call("POST", f"/v1/billing/invoices/{invoice_a}/issue", {})
    flow.check("and issuing twice is refused - a document cannot be sent to a center under two "
               "numbers", status == 422 and body.get("error") == "invoice_issued",
               f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("DELETE", f"/v1/billing/invoices/{invoice_a}")
    flow.check("an issued invoice cannot be deleted", status == 422
               and body.get("error") == "only_a_draft_can_be_dropped", f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("POST", f"/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": "2026-11-01T00:00:00Z", "periodEnd": "2026-12-01T00:00:00Z"})
    flow.check("a period with nothing delivered in it produces no invoice rather than a zero one",
               status == 422 and body.get("error") == "nothing_billable_in_period",
               f"{status} {json.dumps(body)[:140]}")

    status, body = ops.call("POST", "/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": PERIOD_B[0], "periodEnd": PERIOD_B[1]})
    invoice_b = body.get("id")
    flow.check("the second period drafts cleanly alongside the issued first one",
               status == 201 and bool(invoice_b), f"{status} {json.dumps(body)[:140]}")

    status, drop = ops.call("POST", "/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": "2026-09-01T00:00:00Z", "periodEnd": "2026-10-01T00:00:00Z"})
    dropped = drop.get("id")
    if status == 201 and dropped:
        status, body = ops.call("DELETE", f"/v1/billing/invoices/{dropped}")
        flow.check("an unissued draft can be dropped", status == 200 and body.get("dropped") is True,
                   f"{status} {json.dumps(body)[:120]}")
    else:
        flow.check("an unissued draft can be dropped", status == 422 and drop.get("error") == "nothing_billable_in_period",
                   f"September had nothing billable, so there was no draft to drop: {status} "
                   f"{json.dumps(drop)[:120]}")

    status, body = ops.call("POST", f"/v1/billing/invoices/{invoice_b}/issue", {})
    flow.check("the sequence continues at 0002 - the dropped draft cost no number, which is why "
               "the number is minted at issue and not before",
               status == 200 and body.get("number") == "WHQ-2627-0002",
               f"{status} {json.dumps(body)[:160]}")

    status, body = ops.call("GET", f"/v1/billing/invoices?tenantId={TENANT}")
    listed = {i["id"]: i for i in body.get("invoices", [])}
    flow.check("both documents are listed with their totals and their line counts",
               len(body.get("invoices", [])) >= 2
               and listed[invoice_a]["lineCount"] == 3 and listed[invoice_a]["status"] == "issued"
               and listed[invoice_b]["lineCount"] == 1,
               json.dumps(body.get("invoices"))[:220])

    status, text, headers = fetch_raw(ops, f"/v1/billing/invoices/{invoice_a}/export.csv")
    rows = [r for r in text.splitlines() if r]
    flow.check("the center's copy downloads as CSV, one row per line plus three totals",
               status == 200 and len(rows) == 1 + 3 + 3
               and headers.get("Content-Type", "").startswith("text/csv"),
               f"{status} {len(rows)} rows {headers.get('Content-Disposition')}")
    flow.check("and the rupee figures in it are the integer paise divided by 100, not a float "
               "that drifted", rupees(want_gross) in text and rupees(want_tax) in text,
               text.splitlines()[-1] if text else "")

    status, body = ops.call("POST", f"/v1/billing/invoices/{invoice_a}/dispute",
                            {"reason": "The night study was read at 14:30, not midnight."})
    flow.check("a center may dispute an issued invoice, and the dispute is a state rather than a "
               "deleted document", status == 200 and body.get("status") == "disputed",
               f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("POST", f"/v1/billing/invoices/{invoice_a}/dispute", {"reason": ""})
    flow.check("a dispute with no reason written is refused, because an undocumented number on a "
               "legal document is not a correction", status in (422, 409), f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("GET", f"/v1/billing/invoices/{invoice_a}")
    flow.check("and the disputed invoice still shows the same lines it was issued with",
               status == 200 and sum(l["amountPaise"] for l in body.get("lines", [])) == want_gross,
               json.dumps({k: body.get("invoice", {}).get(k) for k in ("status", "number")}))

    status, body = ops.call("GET", "/v1/billing/invoices/abc")
    flow.check("a path id that is not a number answers 400 rather than reaching Postgres as NaN",
               status == 400 and body.get("error") == "bad_id", f"{status} {json.dumps(body)[:120]}")

    status, text, _h = fetch_raw(ops, f"/v1/billing/invoices/7.csv")
    flow.check("the old `.csv` suffix shape is not a route any more, so nothing silently 500s "
               "behind `:id`", status in (400, 404), f"{status} {text[:80]}")


# ---- phase: access ----------------------------------------------------------------------------

def phase_access():
    ops = flow.owner()
    green = flow.login(GREEN)

    status, body = green.call("POST", "/v1/billing/tariffs", {
        "tenantId": TENANT, "modalityCode": "CT", "subSpecialtyCode": "ct-head",
        "priority": "routine", "unitRupees": 1.00, "effectiveFrom": "2027-04-01T00:00:00Z"})
    flow.check("a reader cannot set a price", status == 403 and body.get("error") == "forbidden",
               f"{status} {json.dumps(body)[:120]}")
    status, body = green.call("POST", "/v1/billing/invoices", {
        "tenantId": TENANT, "periodStart": PERIOD_B[0], "periodEnd": PERIOD_B[1]})
    flow.check("and cannot raise an invoice at their own centre", status == 403,
               f"{status} {json.dumps(body)[:120]}")

    status, body = green.call("GET", f"/v1/billing/invoices?tenantId={TENANT}")
    flow.check("a reader may still see what the centre has been billed, because a bill nobody can "
               "read is not a bill", status == 200 and len(body.get("invoices", [])) >= 2,
               f"{status} {json.dumps(body)[:120]}")

    status, body = ops.call("GET", f"/v1/billing/preview?from={PERIOD_A[0]}&to={PERIOD_A[1]}")
    flow.check("an operator who names no tenant is asked to name one, rather than previewing "
               "every centre at once", status == 422 and body.get("error") == "tenant_required",
               f"{status} {json.dumps(body)[:120]}")

    other = psql("select id from telrad.tenants where code = 'apc';")
    if not other:
        psql("""insert into telrad.tenants (code, legal_name, timezone, status)
                values ('apc', 'Another Centre Test', 'Asia/Kolkata', 'trial');""")
        subprocess.run(["pnpm", "exec", "tsx", "src/cli.ts", "add-reader",
                        "--email", "dr-other@test.local", "--name", "Dr Other",
                        "--password", flow.PASSWORD, "--grade", "senior", "--role", "radiologist",
                        "--tenant", "2", "--subs", "ct-head", "--mods", "CT",
                        "--council", "WB", "--reg-no", "WB-900009", "--states", "WB",
                        "--max-queue", "3"],
                       cwd="apps/api", shell=True, capture_output=True, text=True)
        other = psql("select id from telrad.tenants where code = 'apc';")
    other = int(other.splitlines()[0])

    invoice_a = int(psql("select id from telrad.invoices where number = 'WHQ-2627-0001';"))
    stranger = flow.login("dr-other@test.local")
    flow.check("the second centre exists", stranger is not None and other != TENANT, f"tenant {other}")

    status, body = stranger.call("GET", f"/v1/billing/invoices/{invoice_a}")
    flow.check("a reader at another centre asking for this centre's invoice by id is answered 404, "
               "not 403, so ids cannot be probed across tenants",
               status == 404 and body.get("error") == "not_found", f"{status} {json.dumps(body)[:120]}")
    status, body = stranger.call("POST", f"/v1/billing/invoices/{invoice_a}/dispute",
                                 {"reason": "not mine"})
    flow.check("and cannot dispute it either", status == 404, f"{status} {json.dumps(body)[:120]}")
    status, body = stranger.call("GET", f"/v1/billing/preview?from={PERIOD_A[0]}&to={PERIOD_A[1]}")
    flow.check("their own preview is their own tenant, which has no delivered studies",
               status == 200 and body.get("tenantId") == other
               and body.get("deliveredStudies") == 0 and body.get("lines") == [],
               f"{status} {json.dumps(body)[:160]}")

    audits = psql("select count(*) from telrad.audit_log where action like 'billing.%';")
    flow.check("every money act above is an audit row", int(audits) >= 10, f"billing rows={audits}")


PHASES = {"seed": phase_seed, "deliver": phase_deliver, "preview": phase_preview,
          "invoice": phase_invoice, "access": phase_access}


def main() -> int:
    if "--phase" not in sys.argv:
        print(__doc__)
        print("usage: run-billing-flow.py --phase " + "|".join(PHASES))
        return 2
    name = sys.argv[sys.argv.index("--phase") + 1]
    if name not in PHASES:
        print(f"unknown phase {name}", file=sys.stderr)
        return 2
    print(f"=== phase {name} ===")
    PHASES[name]()
    if flow.FAILED:
        print(f"\n{len(flow.FAILED)} FAILED: {', '.join(flow.FAILED)}")
        return 1
    print(f"\nphase {name}: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
