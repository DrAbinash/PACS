import { describe, expect, it } from 'vitest';
import {
  LIMITS, cleanText, normaliseMrn, safeFilename, sniffKind,
  validateOrderInput, validatePatientInput, validDicomDate,
} from '../src/validate.js';

describe('cleanText', () => {
  it('strips control characters that could forge a line in a printed report', () => {
    expect(cleanText('Findings\u0000normal\u000d\u000aimpression', 200)).toBe('Findings normal impression');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(cleanText('  Ramesh   Kumar  ', 200)).toBe('Ramesh Kumar');
  });

  it('caps length', () => {
    expect(cleanText('a'.repeat(500), 100).length).toBe(100);
  });
});

describe('safeFilename', () => {
  it('accepts a plain DICOM filename', () => {
    expect(safeFilename('IMG_0001.dcm')).toBe('IMG_0001.dcm');
  });

  it('rejects traversal and keeps only a safe last segment', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..')).toBeNull();
    expect(safeFilename('')).toBeNull();
    expect(safeFilename('../../etc/passwd')!.includes('/')).toBe(false);
  });

  it('keeps only the last path segment when an agent sends a full path', () => {
    expect(safeFilename('C:\\dicom\\study\\IMG_1.dcm')).toBe('IMG_1.dcm');
    expect(safeFilename('/var/spool/IMG_2.dcm')).toBe('IMG_2.dcm');
  });

  it('neutralises shell and unicode oddities in a name', () => {
    expect(safeFilename('a`b;rm -rf$().dcm')).toBe('a_b_rm_-rf___.dcm');
  });
});

describe('sniffKind', () => {
  const dicom = new Uint8Array(200);
  dicom.set([0x44, 0x49, 0x43, 0x4d], 128);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(160).fill(0)]);

  it('recognises a Part-10 preamble at byte 128', () => {
    expect(sniffKind(dicom)).toBe('dcm');
  });

  it('recognises a zip archive', () => {
    expect(sniffKind(zip)).toBe('zip');
  });

  it('quarantines anything else instead of filing it', () => {
    expect(sniffKind(new Uint8Array([1, 2, 3, 4]))).toBe('non_dicom');
    expect(sniffKind(new Uint8Array(200))).toBe('non_dicom');
  });
});

describe('patient validation', () => {
  it('accepts a complete record', () => {
    expect(validatePatientInput({ mrn: 'p-00010', fullName: 'Ramesh Kumar', gender: 'm', dob: '19780412' }).ok).toBe(true);
  });

  it('refuses an unnamed patient and a dashed dob rather than re-reading it', () => {
    const v = validatePatientInput({ mrn: '', fullName: 'x', dob: '12-04-1978' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toEqual(['mrn', 'fullName', 'dob']);
  });

  it('normalises the mrn so the same person is not filed twice', () => {
    expect(normaliseMrn(' p 00010 ')).toBe('P00010');
    expect(normaliseMrn('P-00010')).toBe('P-00010');
  });
});

describe('order validation', () => {
  const good = {
    accessionNumber: 'ACC-20261009-CT-001', patientId: 1, modalityCode: 'CT',
    priority: 'urgent', scheduledDate: '20261009', siteId: 1,
  };

  it('accepts a complete order', () => {
    expect(validateOrderInput(good).ok).toBe(true);
  });

  it('refuses an unknown modality string and a non-integer patient', () => {
    const v = validateOrderInput({ ...good, modalityCode: 'cat scan', patientId: 'one' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('modalityCode');
    expect(v.violations.map((x) => x.field)).toContain('patientId');
  });

  it('refuses a priority outside the three contract classes', () => {
    expect(validateOrderInput({ ...good, priority: 'whenever' }).ok).toBe(false);
  });

  it('treats a missing scheduled date as acceptable but a malformed one as not', () => {
    expect(validateOrderInput({ ...good, scheduledDate: '' }).ok).toBe(true);
    expect(validDicomDate('20261009')).toBe(true);
    // An ISO date is accepted because it is unambiguous; a dotted or reversed one
    // is not, because it silently means a different day.
    expect(validDicomDate('2026-10-09')).toBe(true);
    expect(validDicomDate('09-10-2026')).toBe(false);
    expect(validDicomDate('2026.10.09')).toBe(false);
    expect(validDicomDate(undefined)).toBe(true);
  });

  it('survives a JSON body where a field arrives as an object', () => {
    expect(() => validateOrderInput({ ...good, modalityCode: { $: 'CT' } })).not.toThrow();
    expect(validateOrderInput({ ...good, modalityCode: { $: 'CT' } }).ok).toBe(false);
  });

  it('exposes the limits the upload path enforces', () => {
    expect(LIMITS.fileBytesMax).toBeLessThan(LIMITS.batchBytesMax);
    expect(LIMITS.zipEntriesMax).toBeLessThan(LIMITS.batchFilesMax * 10);
  });
});
