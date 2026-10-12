import { describe, expect, it } from 'vitest';
import { buildSecondaryCapture } from '../src/dicom-sc.js';

// A syntactically framed baseline-JPEG-shaped payload is enough here: the SC builder wraps
// bytes, it does not encode pixels, and the invariant under test lives in the wrapper.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

type El = { group: number; element: number; vr: string; value: Uint8Array };

function* walk(bytes: Uint8Array, start: number, stop: number): Generator<El> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = start;
  while (off + 8 <= stop) {
    const group = dv.getUint16(off, true);
    const element = dv.getUint16(off + 2, true);
    const vr = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!);
    const extended = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
    const hdr = extended ? 12 : 8;
    let len = extended ? dv.getUint32(off + 8, true) : dv.getUint16(off + 6, true);
    if (len === 0xffffffff) {
      // Undefined length: the value runs to the boundary (pixel data encapsulation).
      yield { group, element, vr, value: bytes.subarray(off + hdr, stop) };
      return;
    }
    yield { group, element, vr, value: bytes.subarray(off + hdr, off + hdr + len) };
    off += hdr + len;
  }
}

describe('buildSecondaryCapture', () => {
  // Regression: the builder once declared Explicit VR Little Endian while writing
  // encapsulated (undefined-length) Pixel Data — a combination every parser refuses.
  // Orthanc answered 400 "Cannot parse an invalid DICOM file" for every upload, and no
  // unit test looked at the bytes, so the feature shipped dead.
  it('pairs encapsulated pixel data with an encapsulated transfer syntax', () => {
    const out = buildSecondaryCapture({ jpgBytes: JPEG, rows: 8, columns: 8 });
    expect(new TextDecoder().decode(out.bytes.slice(128, 132))).toBe('DICM');

    const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
    const metaEnd = 132 + 12 + dv.getUint32(132 + 8, true); // past (0002,0000) group length
    const meta = [...walk(out.bytes, 132, metaEnd)];
    const ts = meta.find((e) => e.group === 0x0002 && e.element === 0x0010);
    expect(ts).toBeDefined();
    expect(new TextDecoder().decode(ts!.value).replace(/\0+$/, '')).toBe('1.2.840.10008.1.4.50');

    const px = [...walk(out.bytes, metaEnd, out.bytes.length)]
      .find((e) => e.group === 0x7fe0 && e.element === 0x0010);
    expect(px).toBeDefined();
    expect(px!.vr).toBe('OB');
    const item = new DataView(px!.value.buffer, px!.value.byteOffset, px!.value.byteLength);
    expect(item.getUint16(0, true)).toBe(0xfffe);
    expect(item.getUint16(2, true)).toBe(0xe000);
  });

  it('stamps the caller-provided accession so the poller can attribute the study', () => {
    const out = buildSecondaryCapture({ jpgBytes: JPEG, rows: 8, columns: 8, accessionNumber: 'TEL-X1' });
    expect(out.studyInstanceUid).toMatch(/^1\.2\.826\.0\.1\.3680043\.8\.498\./);
    expect(out.bytes.byteLength).toBeGreaterThan(JPEG.byteLength);
  });

  // PS3.5 requires the dataset in ascending tag order; an unsorted one parses here but a
  // strict PACS is entitled to refuse it. The meta group (0002) is ordered by construction.
  it('writes the dataset in ascending tag order', () => {
    const out = buildSecondaryCapture({
      jpgBytes: JPEG, rows: 8, columns: 8,
      patientName: 'Verify Patient', patientId: 'P1', accessionNumber: 'A1',
      studyDescription: 'D', referringPhysicianName: 'R P',
    });
    const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
    const metaEnd = 132 + 12 + dv.getUint32(132 + 8, true);
    const tags = [...walk(out.bytes, metaEnd, out.bytes.length)].map((e) => (e.group << 16) | e.element);
    for (let i = 1; i < tags.length; i++) expect(tags[i]!).toBeGreaterThan(tags[i - 1]!);
  });
});
