import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { printable, renderReportPdf, reportPdfFilename, wrapText, type ReportPdfInput } from '../src/report-pdf.js';

const base: ReportPdfInput = {
  centreName: 'Riverside Diagnostic Centre',
  tenantCode: 'riverside',
  accession: 'ACC-REP-1',
  modality: 'CT',
  subSpecialty: 'ct-head',
  priority: 'urgent',
  studyDate: '20261009',
  receivedAt: '2026-10-09T01:00:00.000Z',
  patient: { name: 'Ramesh Kumar', mrn: 'MRN-4417', sex: 'M', age: '41y', dob: '1985-02-11' },
  referring: { name: 'Dr Prema Rao', registration: 'KA-33921', phone: '+91 98450 00000' },
  version: 1,
  state: 'verified',
  requiresReviewer: true,
  supersedesVersion: null,
  supersededByVersion: null,
  amendmentReason: null,
  sections: {
    clinicalHistory: 'Headache after a fall.',
    technique: 'Non-contrast CT head.',
    findings: 'No haemorrhage, no mass effect, no fracture.',
    impression: 'Normal study.',
    recommendation: '',
  },
  author: { name: 'Dr Chief', registration: 'WB-400004' },
  reviewer: { name: 'Dr Second', registration: 'WB-100001' },
  signedAt: '2026-10-09T03:10:00.000Z',
  verifiedAt: '2026-10-09T04:00:00.000Z',
  criticals: [],
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('renderReportPdf', () => {
  it('produces a PDF whose hash is the hash of the bytes it returned', async () => {
    const out = await renderReportPdf(base);
    expect(String.fromCharCode(...out.bytes.slice(0, 8))).toContain('%PDF-');
    expect(out.pages).toBe(1);
    expect(out.sha256).toBe(sha(out.bytes));
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-for-byte reproducible, because a hash that moves cannot be quoted', async () => {
    // The delivery audit records this value. If the same report hashed differently on
    // Thursday, "the document we sent is the document that was signed" is unanswerable.
    const a = await renderReportPdf(base);
    const b = await renderReportPdf(base);
    expect(a.sha256).toBe(b.sha256);
    const c = await renderReportPdf({ ...base, sections: { ...base.sections, findings: 'A small bleed.' } });
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('does not change when the report is delivered, so the recorded hash survives', async () => {
    // Measured defect: the first version printed "Delivered <ts>" on the page, so the act
    // of delivering rewrote the document whose hash had just been recorded, and a clinic
    // downloading afterwards got different bytes than the ones the audit vouched for.
    const beforeDelivery = await renderReportPdf({ ...base, state: 'verified' });
    const afterDelivery = await renderReportPdf({ ...base, state: 'delivered' });
    expect(afterDelivery.sha256).toBe(beforeDelivery.sha256);
  });

  it('paginates instead of truncating a long report', async () => {
    const long: ReportPdfInput = {
      ...base,
      sections: { ...base.sections, findings: 'A line of findings. '.repeat(400).trim() },
    };
    const out = await renderReportPdf(long);
    expect(out.pages).toBeGreaterThan(1);
    expect(out.bytes.length).toBeGreaterThan(4096);
  });

  it('survives a name the built-in font cannot draw', async () => {
    // pdf-lib throws on an unencodable code point in a WinAnsi font. A clinic must not be
    // unable to download a signed report because of the script a name was written in.
    const out = await renderReportPdf({
      ...base,
      patient: { ...base.patient, name: 'रामेश कुमार' },
      author: { ...base.author, name: 'Dr Ω' },
    });
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.sha256).not.toBe((await renderReportPdf(base)).sha256);
  });
});

describe('printable', () => {
  it('keeps what Helvetica can draw and replaces what it cannot', () => {
    expect(printable('No haemorrhage · no fracture — normal')).toBe('No haemorrhage · no fracture — normal');
    expect(printable('“quoted” …')).toBe('“quoted” …');
    expect(printable('रामेश')).toBe('?????');
    expect(printable('Ω')).toBe('?');
  });

  it('passes a newline through and expands a tab', () => {
    expect(printable('line1\nline2')).toBe('line1\nline2');
    expect(printable('a\tb')).toBe('a  b');
  });

  it('replaces control characters, which would otherwise corrupt the content stream', () => {
    expect(printable('a\u0000b\u0007c')).toBe('a?b?c');
  });
});

describe('wrapText', () => {
  const width = (s: string) => s.length * 6;

  it('wraps on word boundaries at the measured width', () => {
    expect(wrapText('aaa bbb ccc ddd', width, 60)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('keeps an empty line as an empty line', () => {
    expect(wrapText('one\n\ntwo', width, 60)).toEqual(['one', '', 'two']);
    expect(wrapText('one\r\ntwo', width, 60)).toEqual(['one', 'two']);
  });

  it('breaks a token wider than the column instead of running it off the page', () => {
    // width() measures 6 per character, so exactly ten characters fit in 60.
    const out = wrapText('abcdefghijklmnop', width, 60);
    expect(out).toEqual(['abcdefghij', 'klmnop']);
    expect(wrapText('abcdefghijklmnopqrstuvwxy', width, 60)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxy']);
  });

  it('handles a paragraph that mixes both problems', () => {
    const out = wrapText('x abcdefghijklmnop yz', width, 60);
    expect(out.every((line) => line.length <= 10)).toBe(true);
    expect(out.join('')).toContain('abcdefghijklmnop');
  });
});

describe('reportPdfFilename', () => {
  it('never puts a patient identifier in a filename a reception machine indexes', () => {
    expect(reportPdfFilename('ACC/2026#7', 2)).toBe('telrad-ACC-2026-7-v2.pdf');
    expect(reportPdfFilename('', 1)).toBe('telrad-report-v1.pdf');
  });

  it('caps the length so a long accession cannot overflow a path', () => {
    expect(reportPdfFilename('A'.repeat(200), 1).length).toBeLessThanOrEqual('telrad-'.length + 64 + '-v1.pdf'.length);
  });
});

// pdf-lib compresses the content stream, so the document cannot be read back without a
// parser. `lines` is what the renderer drew, which is the same thing a clinic sees on paper.
describe('what the printed report says', () => {
  it('names the patient, the study, both signatures and the timestamps', async () => {
    const { lines } = await renderReportPdf(base);
    expect(lines).toContain('Ramesh Kumar');
    expect(lines).toContain('MRN-4417 · dob 1985-02-11 · M, 41y');
    expect(lines).toContain('REPORT ACC-REP-1');
    expect(lines).toContain('CT · ct-head');
    expect(lines).toContain('Dr Prema Rao · reg KA-33921 · +91 98450 00000');
    expect(lines).toContain('No haemorrhage, no mass effect, no fracture.');
    expect(lines).toContain('Normal study.');
    expect(lines).toContain('Dr Chief');
    expect(lines).toContain('Reporting radiologist · WB-400004');
    expect(lines).toContain('2026-10-09T03:10:00.000Z');
    expect(lines).toContain('Reviewing radiologist · WB-100001');
  });

  it('does not leave a section blank on the page', async () => {
    // An absent Impression reads as "normal" to a hurried clinic; an explicit "not
    // recorded" reads as a gap in the document.
    const { lines } = await renderReportPdf(base);
    expect(lines.filter((l) => l === 'not recorded')).toHaveLength(1);
  });

  it('marks a superseded version, and names the version that replaced it', async () => {
    const { lines } = await renderReportPdf({ ...base, state: 'amended', supersededByVersion: 2 });
    expect(lines.some((l) => l.startsWith('SUPERSEDED by version 2'))).toBe(true);
    const fresh = await renderReportPdf(base);
    expect(fresh.lines.some((l) => l.startsWith('SUPERSEDED'))).toBe(false);
    expect(fresh.sha256).not.toBe('');
  });

  it('says so when a signed report has no second name yet', async () => {
    const { lines } = await renderReportPdf({
      ...base, state: 'signed', reviewer: null, verifiedAt: null,
    });
    expect(lines.some((l) => l.startsWith('Signed, and awaiting a second name'))).toBe(true);
  });

  it('prints the correction and the version it corrects', async () => {
    const { lines } = await renderReportPdf({
      ...base, version: 2, supersedesVersion: 1, amendmentReason: 'A hypodensity was missed.',
    });
    expect(lines).toContain('Amendment of version 1');
    expect(lines).toContain('A hypodensity was missed.');
  });

  it('names the critical finding that was communicated, and who heard it', async () => {
    const { lines } = await renderReportPdf({
      ...base, criticals: [{
        code: 'pneumothorax', label: 'Pneumothorax',
        told: 'Told Dr A. Rao (Medical Officer) by phone',
        acknowledgedAt: '2026-10-10 03:14 UTC', deadlineAt: '2026-10-10 03:10 UTC',
      }],
    });
    expect(lines).toContain('Critical findings communicated');
    expect(lines).toContain('Pneumothorax (pneumothorax)');
    expect(lines).toContain('Told Dr A. Rao (Medical Officer) by phone · acknowledged 2026-10-10 03:14 UTC');
    // Nothing on the page may read as an open loop once the name is on the record.
    expect(lines.some((l) => l.includes('NOT YET RECEIVED'))).toBe(false);
  });

  it('prints an unacknowledged finding as an open loop with the deadline it blew', async () => {
    // The document is the artifact a service argues with afterwards, so the missing half of
    // the loop has to be on paper and not only on the board.
    const { lines } = await renderReportPdf({
      ...base, criticals: [{
        code: 'aortic-dissection', label: 'Suspected aortic dissection',
        told: null, acknowledgedAt: null, deadlineAt: '2026-10-10 03:10 UTC',
      }],
    });
    expect(lines).toContain('Suspected aortic dissection (aortic-dissection)');
    expect(lines).toContain('Receiver not recorded · acknowledgement NOT YET RECEIVED (was due 2026-10-10 03:10 UTC)');
  });

  it('prints an unprintable name as question marks rather than dropping the patient row', async () => {
    const { lines } = await renderReportPdf({
      ...base, patient: { ...base.patient, name: 'रामेश कुमार' },
    });
    expect(lines).toContain('????? ?????');
  });
});
