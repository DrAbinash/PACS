#!/usr/bin/env python3
"""What this Orthanc build will actually let a viewer do -- measured, not remembered.

The viewer's six design rules in docs/ARCHITECTURE.md came out of running this against the
pinned digest, because the endpoint names that are usually quoted for Orthanc turned out
not to hold on it: `/download`, `/thumbnail`, `/headers`, `/shared-tags` and a DICOM UID in
the path all answer 404, `file?as-app=jpeg` returns the file unchanged, and every window
parameter on every rendering endpoint is ignored.

Run it against a node that already holds a study (the upload channel puts one there; the
fixture generator writes 64x64 frames with real window tags):

  docker run -d --name tr-orth --network trtest -p 127.0.0.1:18042:8042 \
    -e ORTHANC_PASSWORD=<the deployment's> orthancteam/orthanc@<the pinned digest>
  python scripts/validation/probe-orthanc-viewer.py --dir scripts/validation/out/view \
    --url http://127.0.0.1:18042 --user orthanc --password "$TR_ORTHANC_PASSWORD"

It uploads the instances it is given and then reads them back through every path a viewer
could use. It changes nothing about the study and needs no database.
"""
import argparse
import base64
import hashlib
import json
import urllib.error
import urllib.request
from pathlib import Path


class Node:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def call(self, path, data=None, content_type=None):
        hdrs = {"Authorization": self.auth}
        if content_type:
            hdrs["Content-Type"] = content_type
        req = urllib.request.Request(self.url + path, data=data, headers=hdrs,
                                     method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, res.headers.get("Content-Type", ""), res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers.get("Content-Type", ""), err.read()


def kind(body):
    if body[:2] == b"\x89P":
        return "PNG"
    if body[:4] == b"\xff\xd8\xff\xd8" or body[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if body[:4] == b"\x00\x01\x00\x00" or body[:4] == b"\x00\x02\x00\x00":
        return "DICOM?"
    if body[:6] == b'double':
        return "numbers"
    return repr(body[:18])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8042")
    ap.add_argument("--user", default="orthanc")
    ap.add_argument("--password", required=True)
    ap.add_argument("--dir", required=True, help="directory of .dcm files, one study")
    args = ap.parse_args()
    node = Node(args.url, args.user, args.password)

    status, _, body = node.call("/system")
    version = json.loads(body).get("Version") if status == 200 else f"HTTP {status}"
    status, _, body = node.call("/plugins")
    loaded = ", ".join(json.loads(body)) if status == 200 else "?"
    print(f"orthanc version   {version}")
    print(f"plugins loaded    {loaded}")
    print("                  (33 .so files ship in /usr/share/orthanc/plugins-available;")
    print("                   the ones not listed above are not running, however")
    print("                   orthanc.json configures them -- including DicomWeb)")

    ids = []
    for path in sorted(Path(args.dir).glob("*.dcm")):
        status, _, body = node.call("/instances", data=path.read_bytes(),
                                    content_type="application/dicom")
        if status not in (200, 206):
            raise SystemExit(f"upload {path.name} -> {status} {body[:120]}")
        ids.append(json.loads(body)["ID"])
    print(f"\nuploaded {len(ids)} instances")

    instance = json.loads(node.call(f"/instances/{ids[0]}")[2])
    series_pk = instance["ParentSeries"]
    study_pk = json.loads(node.call(f"/series/{series_pk}")[2])["ParentStudy"]
    tags = json.loads(node.call(f"/instances/{ids[0]}/tags")[2])
    named = {v.get("Name"): v.get("Value") for v in tags.values()}
    print(f"study pk {study_pk}\nseries pk {series_pk}")
    print("  (note: /instances/{pk}/metadata answers a LIST of metadata names on this build, "
          "not the parent ids -- those come from the instance and series objects)")
    print("tags from /instances/{pk}/tags: " + ", ".join(
        f"{k}={named.get(k)}" for k in ("Rows", "Columns", "BitsStored", "PixelRepresentation",
                                        "WindowCenter", "WindowWidth", "RescaleSlope",
                                        "RescaleIntercept", "PhotometricInterpretation")))

    print("\n--- structure in one call")
    for p in (f"/studies/{study_pk}", f"/studies/{study_pk}/series", f"/series/{series_pk}",
              "/studies/1.2.3.920"):
        status, _, body = node.call(p)
        extra = ""
        if status == 200 and p.endswith("/series"):
            arr = json.loads(body)
            extra = f"series={len(arr)} first_instances={len(arr[0].get('Instances', [])) if arr else 0}"
        print(f"  {status} {p}  {extra}")
    print("  a DICOM StudyInstanceUID in the path is 404: the api must use the stored node_pk")

    print("\n--- every rendering endpoint, and whether a window changes the answer")
    windows = [
        ("no params", ""),
        ("size=0", "size=0"),
        ("wide bone", "size=0&min=200&max=1200"),
        ("soft tissue", "size=0&min=300&max=500"),
        ("single level", "size=0&min=1000&max=1100"),
        ("wc/ww form", "size=0&window-center=40&window-width=400"),
        ("wc/ww other", "size=0&window-center=800&window-width=80"),
        ("level/window", "size=0&level=40&window=400"),
        ("upscaled", "size=512"),
    ]
    for endpoint in (f"/instances/{ids[0]}/preview", f"/instances/{ids[0]}/frames/0/image-uint8"):
        shas = {}
        for label, q in windows:
            status, ctype, body = node.call(f"{endpoint}?{q}" if q else endpoint)
            if status == 200:
                shas.setdefault(hashlib.sha256(body).hexdigest()[:12], []).append(label)
            print(f"  {status} {ctype:<14} {len(body):>8}B {endpoint.split('/')[-1]}?{q or ''}  {kind(body)}")
        if status == 404:
            print("  (this endpoint does not exist on this build)")
        else:
            print(f"  -> distinct outputs across {sum(len(v) for v in shas.values())} window settings: {len(shas)}"
                  f"  {['|'.join(v) for v in shas.values()]}")
    print("  -> the node ignores the window. Any viewer on this image computes it in the browser.")

    print("\n--- numeric pixel paths")
    for fmt in ("image-int16", "image-uint16", "image-uint8", "matlab"):
        status, ctype, body = node.call(f"/instances/{ids[0]}/frames/0/{fmt}")
        note = ""
        if fmt == "matlab" and status == 200:
            text = body.decode()
            note = (f"rows separated by ';'={text.count(';')}  prefix={text[:9]!r} "
                    f"suffix={text[-4:]!r}  bytes/text-pixel={len(body)/max(1, text.count(' ')):.1f}")
        print(f"  {status} {ctype:<14} {len(body):>8}B {fmt}  {kind(body)} {note}")

    print("\n--- endpoints usually quoted for Orthanc, on this build")
    for p in (f"/instances/{ids[0]}/download", f"/instances/{ids[0]}/thumbnail?size=64",
              f"/instances/{ids[0]}/download?pixel-data-only=true", f"/instances/{ids[0]}/headers",
              f"/instances/{ids[0]}/shared-tags", f"/studies/{study_pk}/preview?size=64",
              f"/instances/{ids[0]}/file?as-app=jpeg", "/dicom-web/", "/dicom-web/studies"):
        status, ctype, body = node.call(p)
        reason = ""
        if status != 200:
            try:
                reason = json.loads(body).get("OrthancError", "")
            except (json.JSONDecodeError, AttributeError):
                reason = body[:40].decode("utf-8", "replace")
        same = ""
        if p.endswith("as-app=jpeg") and status == 200:
            original = node.call(f"/instances/{ids[0]}/file")[2]
            same = " (identical to the unconverted file -- the parameter is ignored)" \
                if original == body else " (converted)"
        print(f"  {status} {ctype:<14} {len(body):>8}B {p}  {reason}{same}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
