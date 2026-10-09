import { describe, expect, it } from 'vitest';
import {
  AUTO_LINK_THRESHOLD, resolveStudyToOrder, scoreOrder, type CandidateOrder,
} from '../src/match.js';

const base: CandidateOrder = {
  orderId: 1,
  accessionNumber: 'ACC-20261008-US-021',
  patientName: 'RAMESH KUMAR',
  patientMrn: 'P-00010',
  dob: '19780412',
  studyDate: '20261008',
  modalityCode: 'US',
  siteId: 1,
};

describe('accession path', () => {
  it('links on a unique accession match without consulting the score', () => {
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: 'acc 20261008 us 021', patientName: 'R KUMAR', patientBirthDate: '19900101' },
      [base],
    );
    expect(r.method).toBe('accession');
    expect(r.state).toBe('linked');
    expect(r.score).toBe(1);
  });

  it('refuses to pick between two orders sharing an accession', () => {
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: 'ACC-20261008-US-021' },
      [base, { ...base, orderId: 2 }],
    );
    expect(r.state).toBe('ambiguous');
    expect(r.reasons).toContain('accession_matches_multiple_orders');
  });
});

describe('hard floors', () => {
  it('never auto-links a different patient name even if everything else agrees', () => {
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: null, patientName: 'SITA DEVI' },
      [base],
    );
    expect(r.state).not.toBe('linked');
    expect(r.reasons).toContain('excluded_1_contradictory_orders');
  });

  it('never auto-links a contradicting date of birth', () => {
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: null, patientBirthDate: '19991231' },
      [base],
    );
    expect(r.state).not.toBe('linked');
  });

  it('never auto-links across modality', () => {
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: null, modalityCode: 'MR' },
      [base],
    );
    expect(r.state).not.toBe('linked');
  });

  it('splits two near-equal candidates into ambiguous rather than guessing', () => {
    const twin = { ...base, orderId: 2, accessionNumber: 'OTHER-1' };
    const r = resolveStudyToOrder(
      { ...base, accessionNumber: null, patientName: 'Ramesh Kumar' },
      [base, twin],
    );
    expect(r.state).toBe('ambiguous');
    expect(r.reasons).toContain('two_candidates_within_margin');
  });
});

describe('scored linking', () => {
  it('links a same-name, same-mrn, same-day study', () => {
    const r = resolveStudyToOrder(
      {
        accessionNumber: '', patientName: 'Ramesh Kumar', patientId: 'P-00010',
        patientBirthDate: '19780412', studyDate: '20261008', modalityCode: 'US', siteId: 1,
      },
      [base],
    );
    expect(r.score).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD);
    expect(r.state).toBe('linked');
    expect(r.method).toBe('scored');
  });

  it('orphans a study with no candidate order at all', () => {
    const r = resolveStudyToOrder(
      { accessionNumber: 'NOPE', patientName: 'Unknown Person', studyDate: '20261008', modalityCode: 'CT' },
      [],
    );
    expect(r.state).toBe('orphan');
  });

  it('treats one day of date drift as weaker but not fatal', () => {
    const s = scoreOrder(
      { patientName: 'Ramesh Kumar', patientId: 'P-00010', patientBirthDate: '19780412', studyDate: '20261009', modalityCode: 'US' },
      base,
    );
    const sameDay = scoreOrder(
      { patientName: 'Ramesh Kumar', patientId: 'P-00010', patientBirthDate: '19780412', studyDate: '20261008', modalityCode: 'US' },
      base,
    );
    expect(s).toBeLessThan(sameDay);
    expect(s).toBeGreaterThanOrEqual(0.7);
  });

  it('ignores honorifics and case in names', () => {
    expect(scoreOrder({ patientName: 'DR RAMESH KUMAR MD' }, base)).toBe(
      scoreOrder({ patientName: 'ramesh kumar' }, base),
    );
  });
});
