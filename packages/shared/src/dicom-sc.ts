// A DICOM Secondary Capture (SC) is the simplest SOP class: an image wrapped in just enough
// metadata to be addressable in a PACS. It exists for exactly this case — a workstation that
// needs to inject an image that did not arrive from a modality — and building it here avoids
// pulling in a DICOM library whose feature set is sized for modalities, not wrappers.

// The dataset is encoded Explicit VR Little Endian: every element carries its VR as two
// ASCII bytes, and multi-byte numbers are little-endian. That rule covers every element
// except Pixel Data, which is written encapsulated (undefined length, one fragment per
// frame) — and an encapsulated Pixel Data element is only valid under an encapsulated
// Transfer Syntax. Declaring Explicit VR LE there produced a file every parser refuses:
// Orthanc answered 400 "Cannot parse an invalid DICOM file" (measured 2026-10-12), so
// the syntax must be JPEG Baseline. Any JPEG that is not baseline or extended will be
// stored but may not decode in a viewer; ingest does not parse the JPEG payload itself.

const PREAMBLE = new Uint8Array(128);
const MAGIC = new TextEncoder().encode('DICM');

const TRANSFER_SYNTAX = '1.2.840.10008.1.4.50';
const SC_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7';

export type DicomScInput = {
  jpgBytes: Uint8Array;
  rows: number;
  columns: number;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  accessionNumber?: string;
  studyId?: string;
  studyDescription?: string;
  referringPhysicianName?: string;
  manufacturer?: string;
  institutionName?: string;
};

export type DicomScOutput = {
  bytes: Uint8Array;
  sopInstanceUid: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
};

// A DICOM UID is an odd-length string of dot-separated numeric components, padded with a
// trailing zero byte if even. The 64-byte limit is the standard's; a UID built from a
// timestamp plus a random suffix stays well under it.
export function generateUid(root: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const uid = `${root}.${ts}.${rand}`;
  return uid.length % 2 === 0 ? uid + '0' : uid;
}

function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return bytes.length % 2 === 0 ? bytes : padRight(bytes);
}

function padRight(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x20;
  return out;
}

function encodePersonName(name: string): Uint8Array {
  const parts = name.split(' ');
  const dicom = parts.length > 1 ? `${parts[0]}^${parts.slice(1).join('^')}` : name;
  return encodeString(dicom);
}

function encodeDate(d: Date): Uint8Array {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return encodeString(`${y}${m}${day}`);
}

function encodeDateTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  const h = d.getUTCHours().toString().padStart(2, '0');
  const mi = d.getUTCMinutes().toString().padStart(2, '0');
  const s = d.getUTCSeconds().toString().padStart(2, '0');
  return encodeString(`${y}${mo}${day}${h}${mi}${s}`);
}

function encodeUint16(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

function encodeUint32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

// PS3.5 7.1.2: OB, OW, SQ, UN and UT always carry a 32-bit length after two reserved
// bytes, even for short values — a short-form OB desynchronizes every conformant parser
// at the first extended-VR element, which here is (0002,0001) two tags into the file.
const EXTENDED_LENGTH_VRS = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);

function encodeTag(group: number, element: number, vr: string, value: Uint8Array): Uint8Array {
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint16(0, group, true);
  new DataView(tag.buffer).setUint16(2, element, true);

  const vrBytes = new TextEncoder().encode(vr);

  if (EXTENDED_LENGTH_VRS.has(vr)) {
    const out = new Uint8Array(12 + value.length);
    out.set(tag, 0);
    out.set(vrBytes, 4);
    new DataView(out.buffer).setUint32(8, value.length, true);
    out.set(value, 12);
    return out;
  }

  const out = new Uint8Array(8 + value.length);
  out.set(tag, 0);
  out.set(vrBytes, 4);
  out.set(encodeUint16(value.length), 6);
  out.set(value, 8);
  return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// The pixel data element (7FE0,0010) uses OB VR with an undefined length when the pixel data
// is encapsulated, but for raw JPEG-in-DICOM the standard path is to wrap it in a single
// fragment item. This is what Orthanc accepts and what viewers decode.
function encodePixelData(jpgBytes: Uint8Array): Uint8Array {
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint16(0, 0x7fe0, true);
  new DataView(tag.buffer).setUint16(2, 0x0010, true);

  const vrBytes = new TextEncoder().encode('OB');
  const undefLen = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

  const itemTag = new Uint8Array(8);
  new DataView(itemTag.buffer).setUint16(0, 0xfffe, true);
  new DataView(itemTag.buffer).setUint16(2, 0xe000, true);
  new DataView(itemTag.buffer).setUint32(4, jpgBytes.length, true);

  const seqDelim = new Uint8Array(8);
  new DataView(seqDelim.buffer).setUint16(0, 0xfffe, true);
  new DataView(seqDelim.buffer).setUint16(2, 0xe0dd, true);

  return concat(tag, vrBytes, new Uint8Array(2), undefLen, itemTag, jpgBytes, seqDelim);
}

export function buildSecondaryCapture(input: DicomScInput): DicomScOutput {
  const now = new Date();
  const studyUid = input.studyInstanceUid ?? generateUid('1.2.826.0.1.3680043.8.498');
  const seriesUid = input.seriesInstanceUid ?? generateUid('1.2.826.0.1.3680043.8.498');
  const sopUid = generateUid('1.2.826.0.1.3680043.8.498');

  // Group 0002 (File Meta) is written first and always in Explicit VR LE; the dataset
  // after it must be sorted by ascending tag — PS3.5 requires the order, and a strict
  // PACS rejects an unsorted dataset even when every element parses.
  const meta: Uint8Array[] = [];
  const ds: { tag: number; bytes: Uint8Array }[] = [];
  const push = (group: number, element: number, vr: string, value: Uint8Array) => {
    const bytes = encodeTag(group, element, vr, value);
    if (group === 0x0002) meta.push(bytes);
    else ds.push({ tag: (group << 16) | element, bytes });
  };

  // File Meta Information (Group 0002) — these are written with Explicit VR Little Endian
  // regardless of the dataset's transfer syntax, and they tell the reader how to decode the
  // rest of the file.
  push(0x0002, 0x0000, 'UL', encodeUint32(0));
  push(0x0002, 0x0001, 'OB', new Uint8Array([0x00, 0x01]));
  push(0x0002, 0x0002, 'UI', encodeString(SC_SOP_CLASS));
  push(0x0002, 0x0003, 'UI', encodeString(sopUid));
  push(0x0002, 0x0010, 'UI', encodeString(TRANSFER_SYNTAX));
  push(0x0002, 0x0012, 'UI', encodeString('1.2.826.0.1.3680043.8.498.1'));
  push(0x0002, 0x0013, 'SH', encodeString('Telrad 1.0'));

  const metaLen = meta.slice(1).reduce((sum, e) => sum + e.length, 0);
  meta[0] = encodeTag(0x0002, 0x0000, 'UL', encodeUint32(metaLen));

  // Patient module
  if (input.patientName) {
    push(0x0010, 0x0010, 'PN', encodePersonName(input.patientName));
  }
  if (input.patientId) {
    push(0x0010, 0x0020, 'LO', encodeString(input.patientId));
  }
  if (input.patientBirthDate) {
    push(0x0010, 0x0030, 'DA', encodeString(input.patientBirthDate));
  }
  if (input.patientSex) {
    push(0x0010, 0x0040, 'CS', encodeString(input.patientSex));
  }

  // Study module
  push(0x0020, 0x000d, 'UI', encodeString(studyUid));
  push(0x0008, 0x0020, 'DA', encodeDate(now));
  push(0x0008, 0x0030, 'TM', encodeDateTime(now));
  if (input.accessionNumber) {
    push(0x0008, 0x0050, 'SH', encodeString(input.accessionNumber));
  }
  if (input.studyId) {
    push(0x0020, 0x0010, 'SH', encodeString(input.studyId));
  }
  if (input.studyDescription) {
    push(0x0008, 0x1030, 'LO', encodeString(input.studyDescription));
  }
  if (input.referringPhysicianName) {
    push(0x0008, 0x0090, 'PN', encodePersonName(input.referringPhysicianName));
  }

  // Series module
  push(0x0020, 0x000e, 'UI', encodeString(seriesUid));
  push(0x0008, 0x0021, 'DA', encodeDate(now));
  push(0x0008, 0x0031, 'TM', encodeDateTime(now));
  push(0x0008, 0x0060, 'CS', encodeString('OT'));
  push(0x0020, 0x0011, 'IS', encodeString('1'));

  // Equipment module
  push(0x0008, 0x0070, 'LO', encodeString(input.manufacturer ?? 'Telrad'));
  if (input.institutionName) {
    push(0x0008, 0x0080, 'LO', encodeString(input.institutionName));
  }

  // SC Equipment module — Conversion Type WSD means "Workstation"
  push(0x0008, 0x0064, 'CS', encodeString('WSD'));

  // SOP Common module
  push(0x0008, 0x0005, 'CS', encodeString('ISO_IR 100'));
  push(0x0008, 0x0016, 'UI', encodeString(SC_SOP_CLASS));
  push(0x0008, 0x0018, 'UI', encodeString(sopUid));
  push(0x0008, 0x0012, 'DA', encodeDate(now));
  push(0x0008, 0x0013, 'TM', encodeDateTime(now));

  // Image Pixel module — for JPEG-in-DICOM, Bits Allocated is 8, Pixel Representation is 0
  // (unsigned), and the Photometric Interpretation is YBR_FULL_422 for color JPEG or MONOCHROME2
  // for grayscale. The viewer decodes the JPEG and ignores these; they are present to satisfy
  // the schema check.
  push(0x0028, 0x0002, 'US', encodeUint16(3));
  push(0x0028, 0x0004, 'CS', encodeString('YBR_FULL_422'));
  push(0x0028, 0x0008, 'US', encodeUint16(1));
  push(0x0028, 0x0010, 'US', encodeUint16(input.rows));
  push(0x0028, 0x0011, 'US', encodeUint16(input.columns));
  push(0x0028, 0x0100, 'US', encodeUint16(8));
  push(0x0028, 0x0101, 'US', encodeUint16(8));
  push(0x0028, 0x0102, 'US', encodeUint16(7));
  push(0x0028, 0x0103, 'US', encodeUint16(0));

  // Pixel Data — encodePixelData writes its own 12-byte extended header, so it goes
  // into the sort set directly; routing it through push() would wrap it twice.
  ds.push({ tag: (0x7fe0 << 16) | 0x0010, bytes: encodePixelData(input.jpgBytes) });

  const dataset = concat(...meta, ...ds.sort((a, b) => a.tag - b.tag).map(e => e.bytes));
  const file = concat(PREAMBLE, MAGIC, dataset);

  return {
    bytes: file,
    sopInstanceUid: sopUid,
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
  };
}
