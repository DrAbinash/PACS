import { describe, expect, it } from 'vitest';
import { classifyStudy } from '../src/classify.js';
import { GRADE_RANK, isNight, mayAmend, reviewerMayClear } from '../src/enums.js';
import { auditRowHash, hashPassword, verifyPassword } from '../src/audit.js';

describe('classifyStudy', () => {
  it('resolves a brain MRI into a subspecialty with no review flag', () => {
    const c = classifyStudy({ Modality: 'MR', StudyDescription: 'MR BRAIN WITH CONTRAST' });
    expect(c.modalityCode).toBe('MR');
    expect(c.subSpecialtyCode).toBe('mr-head');
    expect(c.needsHumanReview).toBe(false);
  });

  it('flags an unrecognised study instead of filing it under a guess', () => {
    const c = classifyStudy({ Modality: 'CR', StudyDescription: 'FILM UNKNOWN PART' });
    expect(c.needsHumanReview).toBe(true);
    expect(c.subSpecialtyCode).toBeNull();
    expect(c.reasons).toContain('region_unresolved');
  });

  it('refuses to invent a modality', () => {
    const c = classifyStudy({ StudyDescription: 'CT CHEST' });
    expect(c.modalityCode).toBe('OT');
    expect(c.reasons).toContain('modality_missing');
  });

  it('reads an emergency from free text', () => {
    expect(classifyStudy({ Modality: 'CT', StudyDescription: 'CT HEAD — TRAUMA' }).priority).toBe('stat');
  });

  it('orders regions so a CTA pulmonary does not file as a chest study', () => {
    const c = classifyStudy({ Modality: 'CT', StudyDescription: 'CTA PULMONARY EMBOL', BodyPartExamined: 'CHEST' });
    expect(c.subSpecialtyCode).toBe('ct-vascular');
  });

  it('never maps a head CT into the MRI pool', () => {
    const c = classifyStudy({ Modality: 'CT', StudyDescription: 'CT HEAD', SeriesDescription: 'HEAD NATIVE' });
    expect(c.subSpecialtyCode).toBe('ct-head');
  });

  it('reads the region from the series when the study description is generic', () => {
    const c = classifyStudy({ Modality: 'MR', StudyDescription: 'ROUTINE', SeriesDescription: 'LUMBAR SPINE' });
    expect(c.subSpecialtyCode).toBe('mr-spine');
  });

  it('does not treat the institution name as a body part', () => {
    const c = classifyStudy({ Modality: 'CR', StudyDescription: '', InstitutionName: 'City Chest Clinic' });
    expect(c.needsHumanReview).toBe(true);
  });

  it('files an obstetric study that says pelvis as obstetric, not abdomen', () => {
    const c = classifyStudy({ Modality: 'US', StudyDescription: 'OBSTETRIC ANOMALY', BodyPartExamined: 'PELVIS' });
    expect(c.subSpecialtyCode).toBe('us-obstetric');
  });
});

describe('two-signature rules', () => {
  it('lets a senior countersign a junior but not the reverse', () => {
    expect(reviewerMayClear('junior', 'senior')).toBe(true);
    expect(reviewerMayClear('senior', 'junior')).toBe(false);
  });

  it('lets a senior countersign another senior', () => {
    expect(reviewerMayClear('senior', 'senior')).toBe(true);
  });

  it('requires a strictly higher grade to amend, and never the author', () => {
    expect(mayAmend('senior', 'chief')).toBe(true);
    expect(mayAmend('senior', 'senior')).toBe(false);
    expect(GRADE_RANK.chief).toBeGreaterThan(GRADE_RANK.senior);
  });
});

describe('night window', () => {
  it('treats 01:30 IST as night and 14:00 IST as day', () => {
    const istOffset = 330;
    expect(isNight(new Date('2026-10-08T01:30:00+05:30'), istOffset)).toBe(true);
    expect(isNight(new Date('2026-10-08T14:00:00+05:30'), istOffset)).toBe(false);
  });

  it('keeps the boundary hours themselves inside the window', () => {
    expect(isNight(new Date('2026-10-08T23:05:00+05:30'), 330)).toBe(true);
    expect(isNight(new Date('2026-10-08T06:55:00+05:30'), 330)).toBe(true);
    expect(isNight(new Date('2026-10-08T07:05:00+05:30'), 330)).toBe(false);
    expect(isNight(new Date('2026-10-08T22:55:00+05:30'), 330)).toBe(false);
  });
});

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('wrong', null)).toBe(false);
  });

  it('uses a fresh salt per hash', async () => {
    expect(await hashPassword('a')).not.toEqual(await hashPassword('a'));
  });
});

describe('audit chain', () => {
  const row = {
    prevHash: 'GENESIS-value',
    actorUserId: 3,
    actorKind: 'human',
    tenantId: 1,
    action: 'report.verified',
    entity: 'reports',
    entityId: '17',
    detail: { b: 1, a: [2, { d: 4, c: 3 }] },
    occurredAt: new Date('2026-10-08T09:00:00Z'),
  };

  it('is stable and independent of object key order', () => {
    expect(auditRowHash(row)).toEqual(auditRowHash(row));
    expect(auditRowHash({ ...row, detail: { a: [2, { c: 3, d: 4 }], b: 1 } })).toEqual(auditRowHash(row));
  });

  it('changes when any signed field changes, including the previous hash', () => {
    expect(auditRowHash({ ...row, entityId: '18' })).not.toEqual(auditRowHash(row));
    expect(auditRowHash({ ...row, prevHash: 'other' })).not.toEqual(auditRowHash(row));
  });
});
