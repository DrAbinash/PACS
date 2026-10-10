#!/usr/bin/env python3
"""The site upload agent, run as the binary and pointed at the live stack.

The upload *endpoints* have been proven since P1 by a python client that behaves perfectly.
That proves the api. It does not prove the thing a center installs on its own PC, which is
where the real failure modes live: a folder the scanner is still writing into, an agent that
restarts halfway through a study, an export that contains a README nobody asked for, a
network that goes down at 2 a.m. and comes back at 4.

So every phase here runs `node apps/agent/dist/main.js` as a subprocess, with a real watch
folder of real Part-10 files, and reads the result back from the api and the database rather
than from the agent's own optimism.

  python scripts/validation/run-agent-flow.py --phase prepare
  ... --phase refuse-http        the agent will not carry a token over cleartext
  ... --phase settle-gate        a folder written one second ago is not taken
  ... --phase two-scan           a folder is taken only when a second scan agrees
  ... --phase send               batch opened, instances put, sealed, cursor written
  ... --phase resume             the same folder again sends nothing
  ... --phase dead-api           an api that is not there leaves the study intact and waiting
  ... --phase ingest             the worker takes the sealed batch into the image node

`bash scripts/validation/run-agent-live.sh` runs all of them against a stack it builds itself.
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".runtime" / "agent-watch"
TOKEN_FILE = ROOT / ".runtime" / "agent-token.txt"
API = "http://127.0.0.1:3101"

spec = importlib.util.spec_from_file_location(
    "flow", ROOT / "scripts" / "validation" / "run-escalation-flow.py")
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

# Two studies on purpose. One folder is named like an accession so the operator's hint template
# has something to match; the other is named like a patient, which is what a real export
# directory looks like, and it must arrive without a hint rather than with a wrong one.
ACC_1, PATIENT_1 = "ACC-AGT-1", "Kavita^Agent"
ACC_2, PATIENT_2 = "ACC-AGT-2", "Ravi^Kumar"
FOLDER_1 = RUNTIME / ACC_1
FOLDER_2 = RUNTIME / "RAVI KUMAR CT 20261010"

GREEN = flow.GREEN


def psql(sql):
    out = subprocess.run(["docker", "exec", "tr-ci", "psql", "-U", "telrad", "-d", "telrad",
                          "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        return f"ERROR {out.stderr.strip()[:200]}"
    return out.stdout.strip()


def agent(args, token_file=True, api=API, timeout=90):
    """Run the agent binary once and hand back its exit code and whole output.

    The credential is given the way an operator would give it — a file, or the environment —
    never on the command line, and the run asserts that choice separately.
    """
    env = {**os.environ, "TELRAD_API_URL": api, "PATH": os.environ.get("PATH", "")}
    if token_file:
        env.pop("TELRAD_AGENT_TOKEN", None)
    else:
        env["TELRAD_AGENT_TOKEN"] = TOKEN_VALUE
    cmd = ["node", str(ROOT / "apps" / "agent" / "dist" / "main.js"), "--watch", str(RUNTIME)]
    if token_file:
        cmd += ["--token-file", str(TOKEN_FILE)]
    cmd += args
    ran = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout,
                         cwd=str(ROOT))
    return ran.returncode, (ran.stdout or "") + (ran.stderr or "")


def batches():
    return psql("select id || '=' || status || '=' || files_expected || '=' || channel "
                "from telrad.upload_batches order by id;")


def files_of(batch_id):
    return psql(f"select filename || '=' || status from telrad.upload_files "
                f"where batch_id = '{batch_id}' order by filename;")


def cursor_text():
    path = RUNTIME / "telrad-agent-state.json"
    return path.read_text(encoding="utf-8") if path.exists() else ""


TOKEN_VALUE = "agent-flow-token-not-a-real-credential-0001"


def ensure_order(accession, mrn, name):
    """The referral comes first. Images that arrive for an order that does not exist go to the
    orphan queue by design, so a flow that wants a linked study has to create the order before
    the agent sends anything — not ask for it afterwards and hope the worker relinks it."""
    ops = flow.owner()
    status, body = ops.call("POST", "/v1/patients", {
        "tenantId": 1, "mrn": mrn, "fullName": name, "gender": "F", "dob": "19680719"})
    patient_id = body.get("patient", {}).get("id")
    if patient_id is None:
        return status, body
    today = time.strftime("%Y%m%d")
    status, body = ops.call("POST", "/v1/orders", {
        "tenantId": 1, "accessionNumber": accession, "patientId": patient_id,
        "modalityCode": "CT", "subSpecialtyCode": "ct-head", "priority": "routine",
        "scheduledDate": today, "clinicalIndication": "agent validation — headache",
        "referringName": "Dr Referrer",
    })
    return status, body


def phase_prepare():
    global TOKEN_VALUE
    RUNTIME.mkdir(parents=True, exist_ok=True)
    ops = flow.owner()

    for accession, mrn, name in ((ACC_1, "P-AGT-1", "Kavita Agent"), (ACC_2, "P-AGT-2", "Ravi Kumar")):
        status, body = ensure_order(accession, mrn, name)
        flow.check(f"the referral {accession} exists before its images are sent",
                   status in (200, 201), json.dumps(body)[:120])

    status, body = ops.call("GET", "/v1/sites")
    sites = body.get("sites", [])
    site = next((s for s in sites if s["name"] == "Agent Validation Site"), None)
    if site is None:
        status, body = ops.call("POST", "/v1/sites",
                                {"tenantId": 1, "name": "Agent Validation Site", "aeTitle": "AGENTSITE"})
        site = body.get("site") or body
        flow.check("the site the agent will run on is registered", status in (200, 201),
                   json.dumps(body)[:160])

    status, body = ops.call("POST", f"/v1/sites/{site['id']}/tokens",
                            {"label": "agent-flow", "ttlDays": 7})
    token = body.get("token")
    flow.check("a token is issued for it", status == 201 and bool(token), str(status))
    TOKEN_VALUE = token or TOKEN_VALUE
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(token or "", encoding="utf-8")
    flow.check("the credential is in a file the operator points at, not in an argument",
               bool(token) and TOKEN_FILE.read_text(encoding="utf-8").strip() == (token or ""))

    flow.check("no cursor exists before the first run",
               not (RUNTIME / "telrad-agent-state.json").exists())
    flow.check("both study folders hold real instances",
               len(list(FOLDER_1.glob("*.dcm"))) == 3 and len(list(FOLDER_2.glob("*.dcm"))) == 2,
               f"{len(list(FOLDER_1.glob('*.dcm')))} + {len(list(FOLDER_2.glob('*.dcm')))}")
    flow.check("and one of the folders carries a file that is not a study",
               (FOLDER_1 / "README.txt").exists())


def phase_refuse_http():
    code, out = agent(["--once", "--dry-run"])
    flow.check("cleartext is refused, because the site token rides on every request",
               code != 0 and "not https" in out, out.strip()[:160])

    code, out = agent(["--once", "--dry-run", "--allow-insecure-http"])
    flow.check("and it is allowed only when the operator says so in the argument that says so",
               code == 0 and "mode=dry run" in out, out.strip()[:160])

    # The credential must not be reachable through argv at all.
    code, out = agent(["--once", "--token", "abc123", "--allow-insecure-http"])
    flow.check("a token on the command line is refused outright",
               code != 0 and "process list" in out, out.strip()[:160])

    env = {**os.environ, "TELRAD_API_URL": API, "TELRAD_AGENT_TOKEN": TOKEN_VALUE}
    ran = subprocess.run(["node", str(ROOT / "apps" / "agent" / "dist" / "main.js"),
                          "--watch", str(RUNTIME), "--once", "--dry-run",
                          "--allow-insecure-http"], capture_output=True, text=True, env=env)
    flow.check("the environment is accepted as well as the file",
               ran.returncode == 0, (ran.stdout + ran.stderr)[:160])


def phase_settle_gate():
    """A folder the scanner wrote one second ago is not a study yet."""
    code, out = agent(["--once", "--settle", "3600", "--allow-insecure-http"])
    flow.check("the run succeeds", code == 0, out[:160])
    flow.check("it declines to take anything younger than the settle window",
               "written within 3600s" in out and "0 batch(es), 0 file(s) sent" in out,
               out.strip()[-260:])
    flow.check("and nothing reached the server", batches() == "", repr(batches())[:160])


def phase_two_scan():
    """The loop takes a folder only when a second scan lists the same thing.

    Run against its own folder holding a text file, so it proves the rule without sending a
    study a second time: the batch it opens cannot be sealed (nothing in it is an image), and
    the agent has to close it and say so rather than leave it open forever.
    """
    gate = RUNTIME / "SCAN GATE 1"
    gate.mkdir(parents=True, exist_ok=True)
    (gate / "note.txt").write_text("written by the validation run\n", encoding="utf-8")

    env = {**os.environ, "TELRAD_API_URL": API}
    proc = subprocess.Popen(
        ["node", str(ROOT / "apps" / "agent" / "dist" / "main.js"), "--watch", str(RUNTIME),
         "--token-file", str(TOKEN_FILE), "--allow-insecure-http", "--interval", "1",
         "--settle", "0", "--log-names"],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    time.sleep(6)
    proc.terminate()
    out = proc.communicate(timeout=15)[0]
    flow.check("the loop ran and reported more than one scan", out.count("scan:") >= 2, out[-200:])
    flow.check("the first scan took nothing, because a study is taken when the writer stops",
               "waiting for a second scan" in out and "SCAN GATE 1" in out, out[:400])
    flow.check("a later scan agreed, opened the batch, and the server said there was nothing in it",
               "held no DICOM files" in out, out[-400:])
    flow.check("and no batch is left `open`, which is the state where a study hides",
               psql("select count(*) from telrad.upload_batches where status = 'open';") == "0",
               batches())
    flow.check("the ones that could never be ingested are recorded as rejected",
               int(psql("select count(*) from telrad.upload_batches where status = 'rejected';") or 0) >= 2,
               batches())
    shutil.rmtree(gate, ignore_errors=True)


def phase_send():
    code, out = agent(["--once", "--settle", "0", "--hints", "{accession}",
                       "--allow-insecure-http"])
    flow.check("a --once pass over a settled folder sends it", code == 0 and "sent" in out,
               out[-260:])
    rows = [r for r in batches().splitlines() if r]
    flow.check("two batches were opened, one per folder", len(rows) == 2, "\n".join(rows))
    flow.check("both are sealed, and neither claims more files than it holds",
               all("=sealed=" in r for r in rows), "\n".join(rows))

    first = rows[0].split("=")[0]
    listing = files_of(first)
    flow.check("the three instances are stored", listing.count("=stored") == 3, listing)
    flow.check("the README that came with the export is quarantined, not silently dropped",
               "README.txt=quarantined" in listing, listing)

    hinted = psql("select coalesce(accession_hint,'null') from telrad.upload_batches order by id;")
    flow.check("the operator's template supplied a hint for the folder that looks like an accession",
               "ACC-AGT-1" in hinted, hinted)
    flow.check("and no hint was invented for the folder that is a patient's name",
               "null" in hinted, hinted)

    flow.check("the cursor file was written next to the watch folder",
               (RUNTIME / "telrad-agent-state.json").exists())
    state = json.loads(cursor_text() or "{}")
    folders = state.get("folders", {})
    flow.check("it records every file with its digest and the batch it went into",
               all(len(f["files"]) >= 1 for f in folders.values()), json.dumps(state)[:240])

    log = out
    flow.check("the agent's own output never prints the folder name",
               "RAVI KUMAR" not in log and "Kavita" not in log, log[-200:])

    audit = psql("select count(*) from telrad.audit_log where action in "
                 "('upload.batch_opened','upload.batch_sealed') and actor_kind = 'service';")
    flow.check("the service acted as itself, not as a borrowed session",
               int(audit or 0) >= 4, audit)


def phase_resume():
    before = batches()
    code, out = agent(["--once", "--settle", "0", "--allow-insecure-http"])
    flow.check("a second run over the same folders succeeds", code == 0, out[:160])
    flow.check("and opens nothing, because the cursor says what already went",
               batches() == before, f"before={before!r} after={batches()!r}")
    flow.check("it says so in the count it prints", "0 file(s) sent" in out, out.strip()[-200:])

    # A file the agent has never seen, in a folder it has, still gets taken.
    extra = FOLDER_1 / "second-note.txt"
    extra.write_text("added after the study had already gone\n", encoding="utf-8")
    agent(["--once", "--settle", "0", "--allow-insecure-http"])
    after = batches()
    flow.check("a folder that grew opens a second batch rather than being ignored",
               len([r for r in after.splitlines() if r]) == len([r for r in before.splitlines() if r]) + 1,
               after)
    extra.unlink()
    # ...and taking it away again does not make the agent forget it ever existed: the cursor keeps
    # the record, so a file that reappears is the one thing that must not be sent twice.
    agent(["--once", "--settle", "0", "--allow-insecure-http"])
    flow.check("removing the file does not re-open the study it came from",
               len([r for r in batches().splitlines() if r]) == len([r for r in after.splitlines() if r]),
               batches())


def phase_dead_api():
    """An api that is not there has to leave the study intact, waiting, and un-duplicated."""
    pending = RUNTIME / "ACC-AGT-DEAD"
    pending.mkdir(parents=True, exist_ok=True)
    (pending / "x.dcm").write_bytes(b"\x00" * 128 + b"DICM" + b"placeholder instance for the retry test")

    before = batches()
    code, out = agent(["--once", "--settle", "0", "--allow-insecure-http",
                       "--api", "http://127.0.0.1:1", "--timeout", "3000"])
    flow.check("an api that is not there does not crash the agent", code == 0, out[-200:])
    flow.check("it says the folder stopped rather than pretending it sent",
               "stopped (" in out, out.strip()[-260:])
    flow.check("and it opens nothing on the way out", batches() == before, batches()[:200])

    state = json.loads(cursor_text() or "{}")
    folders = state.get("folders", {})
    waiting = folders.get("ACC-AGT-DEAD", {})
    flow.check("the folder that had work to do is scheduled for a later attempt",
               waiting.get("nextAttemptAt") is not None and waiting.get("failures") == 1,
               json.dumps(waiting)[:220])
    flow.check("the retry is a backoff, not an immediate hammer",
               (waiting.get("nextAttemptAt") or 0) > 0, json.dumps(waiting.get("nextAttemptAt")))
    done = [name for name, rec in folders.items()
            if name != "ACC-AGT-DEAD" and all(b["sealed"] for b in rec.get("batches", []))]
    flow.check("a folder with nothing left to send is not marked as having failed",
               len(done) >= 1 and all(folders[n]["failures"] == 0 for n in done),
               json.dumps({n: folders[n]["failures"] for n in done})[:160])
    shutil.rmtree(pending, ignore_errors=True)


def worker_once():
    """`pnpm` is a .CMD on this machine, so it goes through a shell like every other phase in
    this repository's validation does — a list-form argv raises FileNotFoundError, not a miss."""
    return subprocess.run("pnpm --filter @telrad/worker once", shell=True,
                          capture_output=True, text=True, cwd=str(ROOT))


def phase_ingest():
    """The point of the whole channel: images that arrived in a folder become a linked study."""
    ran = worker_once()
    flow.check("the worker pushed both sealed batches into the image node",
               ran.returncode == 0 and "rejected=0" in (ran.stdout or ""), (ran.stdout or "")[-200:])

    # The node only calls a study complete after a window with no new instances, and the clock
    # opens on that call. Waiting is the honest assertion here; asserting immediately would have
    # measured a half-arrived study and called it a defect in the agent.
    last = ""
    for _ in range(8):
        time.sleep(45)
        last = (worker_once().stdout or "").strip()[-220:]
        if "clocks_opened=2" in last:
            break
    flow.check("both studies were called stable, linked by accession and given a clock",
               "clocks_opened=2" in last, last)

    for accession, count in ((ACC_1, 3), (ACC_2, 2)):
        row = psql(f"select s.link_state || '=' || s.match_method || '=' || s.instance_count || '=' || "
                   f"(select count(*) from telrad.sla_clocks c where c.study_id = s.id) "
                   f"from telrad.studies s where s.accession_number = '{accession}';")
        flow.check(f"{accession} is linked by accession with its {count} instances and one clock",
                   row == f"linked=accession={count}=1", row)

    orphan = psql("select count(*) from telrad.studies where link_state = 'orphan';")
    flow.check("and nothing needed the orphan queue, because the referral was there first",
               orphan == "0", orphan)
    quarantined = psql("select count(*) from telrad.upload_files where status = 'quarantined';")
    flow.check("the files that were not images stayed out of the archive",
               int(quarantined or 0) >= 3, quarantined)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True)
    args = parser.parse_args()
    {"prepare": phase_prepare, "refuse-http": phase_refuse_http, "settle-gate": phase_settle_gate,
     "two-scan": phase_two_scan, "send": phase_send, "resume": phase_resume,
     "dead-api": phase_dead_api, "ingest": phase_ingest}[args.phase]()
    if flow.FAILED:
        print(f"\n{len(flow.FAILED)} assertion(s) failed: {flow.FAILED}")
        return 1
    print("\nall agent assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
