#!/usr/bin/env python3
"""Write valid Part-10 CT instance files for the upload channel tests.

The upload path cannot be proven with a hand-padded file: Orthanc parses what it is
given and refuses anything that is not a real dataset. So this produces genuine
files, with the accession and study uid passed in, and nothing else — no network.

    docker run --rm -v "$PWD/scripts/validation:/v" -e OUT_DIR=/v/out \
      -e ACCESSION=ACC-UPLOAD-0001 -e STUDY_UID=1.2.3.99 -e PATIENT_ID=P-TEST-0001 \
      -e PATIENT_NAME="Ramesh^Kumar" python:3.11-slim sh -c "pip -q install pydicom && python /v/make-study-files.py"
"""
import datetime
import os

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, SecondaryCaptureImageStorage, generate_uid
from pydicom import __version__ as pydicom_version

OUT_DIR = os.environ.get("OUT_DIR", "/v/out")
ACCESSION = os.environ.get("ACCESSION", "ACC-UPLOAD-0001")
STUDY_UID = os.environ.get("STUDY_UID") or generate_uid()
SERIES_UID = os.environ.get("SERIES_UID") or generate_uid()
PATIENT_ID = os.environ.get("PATIENT_ID", "P-TEST-0001")
PATIENT_NAME = os.environ.get("PATIENT_NAME", "Ramesh^Kumar")
PATIENT_BIRTH = os.environ.get("PATIENT_BIRTH", "19780412")
STATION_AET = os.environ.get("STATION_AET", "CT_SCANNER_1")
COUNT = int(os.environ.get("INSTANCE_COUNT", "3"))
MODALITY = os.environ.get("MODALITY", "CT")
BODY_PART = os.environ.get("BODY_PART", "HEAD")
STUDY_DESC = os.environ.get("STUDY_DESC", "CT HEAD")
SERIES_DESC = os.environ.get("SERIES_DESC", "HEAD NATIVE")
# Secondary capture is the storage class a digital radiography plate writes; a CT
# SOP class with Modality=DX would be a file Orthanc accepts and no real PACS sends.
SOP_CLASS = CTImageStorage if MODALITY in ("CT", "MR", "NM") else SecondaryCaptureImageStorage
STUDY_DATE = os.environ.get("STUDY_DATE", datetime.date.today().strftime("%Y%m%d"))


def build(number: int) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SOP_CLASS
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = "1.2.840.10008.1.2.1"  # explicit VR little endian
    meta.ImplementationVersionName = "TELRADTEST"

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = SOP_CLASS
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = STUDY_UID
    ds.SeriesInstanceUID = SERIES_UID
    ds.Modality = MODALITY
    ds.Manufacturer = "Synthetic Vendor"
    ds.InstitutionName = "Demo Clinic"
    ds.StationAETitle = STATION_AET
    ds.AccessionNumber = ACCESSION
    ds.PatientID = PATIENT_ID
    ds.PatientName = PATIENT_NAME
    ds.PatientBirthDate = PATIENT_BIRTH
    ds.PatientSex = "M"
    ds.StudyDate = STUDY_DATE
    ds.StudyTime = "093000"
    ds.StudyDescription = STUDY_DESC
    ds.SeriesDescription = SERIES_DESC
    ds.BodyPartExamined = BODY_PART
    ds.Rows = 4
    ds.Columns = 4
    ds.SamplesPerPixel = 1
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = bytes([number] * 32)
    ds.InstanceNumber = number
    ds.IsLandscape = False
    return ds


os.makedirs(OUT_DIR, exist_ok=True)
names = []
for i in range(1, COUNT + 1):
    ds = build(i)
    name = f"img{i:03d}.dcm"
    path = os.path.join(OUT_DIR, name)
    ds.save_as(path, write_like_original=False)
    names.append(name)
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")

print(f"pydicom={pydicom_version} study={STUDY_UID} accession={ACCESSION} files={','.join(names)}")
