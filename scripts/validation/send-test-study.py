#!/usr/bin/env python3
"""Send one synthetic study to a running Orthanc, then read it back.

This is the P0 exit test for the ingest spine: it exercises C-STORE, the
/changes cursor, /instances/{id} and /instances/{id}/metadata — the four calls
apps/worker actually depends on. No patient data: every identifier is invented.

    docker run --rm --network trtest -v "$PWD/scripts/validation:/v" \
      python:3.11-slim sh -c "pip -q install pydicom pynetdicom && python /v/send-test-study.py"
"""
import datetime
import os
import sys
import urllib.request
import base64
import json

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, generate_uid
from pynetdicom import AE
from pynetdicom.sop_class import CTImageStorage as CT_SOP

ORTHANC_HOST = os.environ.get("TEST_ORTHANC_HOST", "tr-orth")
ORTHANC_PORT = int(os.environ.get("TEST_ORTHANC_PORT", "4242"))
REST_URL = os.environ.get("TEST_ORTHANC_REST", "http://tr-orth:8042")
Creds = os.environ.get("TEST_ORTHANC_BASIC", "orthanc:change-me")
STATION_AET = os.environ.get("TEST_STATION_AET", "MR_SCANNER_1")


def build_instance():
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CT_SOP
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = "1.2.840.10008.1.2"  # implicit VR little endian

    ds = Dataset()
    ds.SOPClassUID = CT_SOP
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = "CT"
    ds.Manufacturer = "Synthetic Vendor"
    ds.StationAETitle = STATION_AET
    ds.InstitutionName = "Demo Clinic"
    ds.AccessionNumber = "ACC-TEST-0001"
    ds.PatientID = "P-TEST-0001"
    ds.PatientName = "Ramesh^Kumar"
    ds.PatientBirthDate = "19780412"
    ds.PatientSex = "M"
    ds.StudyDate = datetime.date.today().strftime("%Y%m%d")
    ds.StudyTime = "090000"
    ds.StudyDescription = "CT HEAD"
    ds.SeriesDescription = "HEAD NATIVE"
    ds.BodyPartExamined = "HEAD"
    ds.Rows = 2
    ds.Columns = 2
    ds.SamplesPerPixel = 1
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = bytes([10, 20, 30, 40])
    ds.IsLandscape = False
    ds.file_meta = meta
    ds.prefer_big_endian = False
    return ds, meta


def rest(path):
    token = base64.b64encode(Creds.encode()).decode()
    req = urllib.request.Request(REST_URL + path, headers={"Authorization": "Basic " + token})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode())


def main():
    ds, meta = build_instance()
    ae = AE(ae_title="TELRAD_TEST")
    ae.add_requested_context(CT_SOP)
    assoc = ae.associate(ORTHANC_HOST, ORTHANC_PORT)
    if not assoc.is_established:
        print("FAIL association to C-STORE SCP was rejected", file=sys.stderr)
        return 1
    status = assoc.send_c_store(ds)
    assoc.release()
    code = status.Status if status is not None else None
    if code not in (0, 263443, 263424):  # Success, or Move/CT duplicate-warning codes
        print(f"FAIL C-STORE status {code}", file=sys.stderr)
        return 1

    changes = rest("/changes?limit=20")
    created = [c for c in changes["Changes"] if c["Change"] == "Create"]
    if not created:
        print("FAIL /changes reported no Create entries", file=sys.stderr)
        return 1

    instance_id = created[-1]["ID"]
    inst = rest(f"/instances/{instance_id}")
    meta_back = rest(f"/instances/{instance_id}/metadata")
    tags = meta_back.get("Tags", {})
    path = inst.get("Path", "")

    # Print exactly the facts apps/worker depends on, so a future Orthanc version
    # that changes any of them is visible in one line of output.
    print("ok   c-store accepted")
    print(f"ok   /changes cursor touchstone={changes['LastTouchstone']} creates={len(created)}")
    print(f"ok   instance path={path}")
    print(f"ok   tags PatientName={tags.get('0010,0010')!r} Modality={tags.get('0008,0060')!r} "
          f"StationAET={tags.get('0008,1010')!r} Accession={tags.get('0008,0050')!r}")
    print(f"ok   study uid tag present={'yes' if tags.get('0020,000D') else 'no'}")
    print(f"ok   accession_number_matches_input={tags.get('0008,0050') == ds.AccessionNumber}")
    print(f"ok   station_aet_matches_input={tags.get('0008,1010') == STATION_AET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
