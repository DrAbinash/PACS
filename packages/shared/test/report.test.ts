import { describe, expect, it } from 'vitest';
import {
  amendDecision, countersignDecision, currentVersion, deliverDecision, deliveryIdempotencyKey,
  isBlank, mayReadReport, missingSections, needsSecondName,
  nextVersion, signDecision, stateAllows,
} from '../src/report.js';
import type { ReportState } from '../src/enums.js';

const full = { findings: 'No fracture.', impression: 'Normal study.' };

describe('stateAllows', () => {
  it('lets a draft be edited and signed but nothing else', () => {
    expect(stateAllows('edit', 'draft')).toBe(true);
    expect(stateAllows('sign', 'draft')).toBe(true);
    expect(stateAllows('countersign', 'draft')).toBe(false);
    expect(stateAllows('amend', 'draft')).toBe(false);
  });

  it('refuses to edit a signed report, because the signature is the point', () => {
    // The route answers 409 with `signed_report_is_immutable`; a silent edit here would
    // put words under two names that neither of them agreed to.
    expect(stateAllows('edit', 'signed')).toBe(false);
    expect(stateAllows('sign', 'signed')).toBe(false);
    expect(stateAllows('countersign', 'signed')).toBe(true);
  });

  it('clears once, and only once', () => {
    expect(stateAllows('countersign', 'verified')).toBe(false);
    expect(stateAllows('countersign', 'delivered')).toBe(false);
  });

  it('amends anything that carries a signature, and closes only a draft', () => {
    expect(stateAllows('amend', 'signed')).toBe(true);
    expect(stateAllows('amend', 'verified')).toBe(true);
    expect(stateAllows('amend', 'delivered')).toBe(true);
    expect(stateAllows('amend', 'amended')).toBe(false);
    expect(stateAllows('withdraw', 'draft')).toBe(true);
    expect(stateAllows('withdraw', 'signed')).toBe(false);
  });

  it('delivers only what has been signed, and never a second time', () => {
    expect(stateAllows('deliver', 'draft')).toBe(false);
    expect(stateAllows('deliver', 'signed')).toBe(true);
    expect(stateAllows('deliver', 'verified')).toBe(true);
    expect(stateAllows('deliver', 'delivered')).toBe(false);
    expect(stateAllows('deliver', 'amended')).toBe(false);
    expect(stateAllows('deliver', 'withdrawn')).toBe(false);
  });
});

describe('blank sections', () => {
  it('counts a newline as nothing written', () => {
    expect(isBlank('\n  \t')).toBe(true);
    expect(isBlank(null)).toBe(true);
    expect(isBlank('a')).toBe(false);
  });

  it('names which required sections are missing, in order', () => {
    expect(missingSections({ findings: 'x', impression: '  ' })).toEqual(['impression']);
    expect(missingSections({})).toEqual(['findings', 'impression']);
    expect(missingSections(null)).toEqual(['findings', 'impression']);
    expect(missingSections(full)).toEqual([]);
  });

  it('does not demand the optional sections', () => {
    expect(missingSections({ findings: 'x', impression: 'y', recommendation: '' })).toEqual([]);
  });
});

describe('signDecision', () => {
  it('refuses a draft whose impression is blank, and says which field', () => {
    const out = signDecision({ state: 'draft', sections: { findings: 'x' } });
    expect(out).toEqual({ ok: false, reason: 'sections_blank:impression' });
  });

  it('names both when neither was written', () => {
    // The message is what tells a reader they are one field away, so it has to say both.
    expect(signDecision({ state: 'draft', sections: {} })).toEqual({
      ok: false, reason: 'sections_blank:findings,impression',
    });
  });

  it('refuses to re-sign something already signed', () => {
    expect(signDecision({ state: 'signed', sections: full })).toEqual({ ok: false, reason: 'not_a_draft' });
  });

  it('accepts a complete draft', () => {
    expect(signDecision({ state: 'draft', sections: full })).toEqual({ ok: true });
  });
});

describe('countersignDecision', () => {
  const base = {
    state: 'signed' as const, authorUserId: 7, reviewerUserId: 9,
    authorGrade: 'senior' as const, reviewerGrade: 'chief' as const,
  };

  it('refuses the author their own review', () => {
    // The database has a CHECK for this too; this is the version that can say why in a
    // response body instead of surfacing as a 500 from a constraint violation.
    expect(countersignDecision({ ...base, reviewerUserId: 7 })).toEqual({ ok: false, reason: 'self_review' });
  });

  it('refuses a reviewer with no recorded grade rather than treating them as junior', () => {
    expect(countersignDecision({ ...base, reviewerGrade: null })).toEqual({
      ok: false, reason: 'reviewer_has_no_grade',
    });
    // A missing author grade is the same kind of gap and it is not the reviewer's fault.
    expect(countersignDecision({ ...base, authorGrade: null, reviewerGrade: 'chief' })).toEqual({
      ok: false, reason: 'author_has_no_grade',
    });
  });

  it('refuses a junior clearing a senior', () => {
    expect(countersignDecision({ ...base, authorGrade: 'chief', reviewerGrade: 'junior' })).toEqual({
      ok: false, reason: 'grade_below_author',
    });
  });

  it('allows equal grades and a higher one', () => {
    expect(countersignDecision({ ...base, reviewerGrade: 'senior' })).toEqual({ ok: true });
    expect(countersignDecision({ ...base, reviewerGrade: 'chief' })).toEqual({ ok: true });
  });

  it('refuses an uncleared draft and an already-cleared report', () => {
    expect(countersignDecision({ ...base, state: 'draft', reviewerGrade: 'chief' })).toEqual({
      ok: false, reason: 'not_signed',
    });
    expect(countersignDecision({ ...base, state: 'verified', reviewerGrade: 'chief' })).toEqual({
      ok: false, reason: 'not_signed',
    });
  });
});

describe('amendDecision', () => {
  const base = {
    state: 'verified' as const, reason: 'Second opinion changed the impression.',
    authorGrade: 'senior' as const, amenderGrade: 'chief' as const,
  };

  it('requires a reason, because an amendment without one is indistinguishable from an edit', () => {
    expect(amendDecision({ ...base, reason: '  ' })).toEqual({ ok: false, reason: 'reason_required' });
    expect(amendDecision({ ...base, reason: null })).toEqual({ ok: false, reason: 'reason_required' });
  });

  it('is stricter than the countersignature rule: equal grade does not amend', () => {
    expect(amendDecision({ ...base, amenderGrade: 'senior' })).toEqual({
      ok: false, reason: 'grade_not_above_author',
    });
    expect(amendDecision({ ...base, amenderGrade: 'chief' })).toEqual({ ok: true });
  });

  it('cannot amend a draft — a draft is edited, not superseded', () => {
    expect(amendDecision({ ...base, state: 'draft', amenderGrade: 'chief' })).toEqual({
      ok: false, reason: 'not_signed',
    });
  });
});

describe('version chain', () => {
  it('starts at 1 and goes one past the highest it has seen', () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([1])).toBe(2);
    expect(nextVersion([2, 1])).toBe(3);
  });

  it('returns the newest live version and never a superseded one', () => {
    const rows = [
      { version: 1, state: 'amended' as const },
      { version: 2, state: 'verified' as const },
    ];
    expect(currentVersion(rows)?.version).toBe(2);
    expect(currentVersion([{ version: 1, state: 'withdrawn' as const }])).toBeNull();
    expect(currentVersion([])).toBeNull();
  });

  it('picks the highest version when the order it arrived in is not the version order', () => {
    const rows = [
      { version: 3, state: 'draft' as const },
      { version: 2, state: 'amended' as const },
      { version: 1, state: 'amended' as const },
    ];
    expect(currentVersion(rows)?.version).toBe(3);
  });
});

describe('mayReadReport', () => {
  const asCenter = (state: ReportState, role = 'center_staff', reader = 20) =>
    mayReadReport({ state, authorUserId: 7, readerUserId: reader, readerRole: role });

  it('keeps an unfinished draft from the center that commissioned it', () => {
    // The half-written sentence a reader left at 03:00 is not a diagnosis, and the
    // referring clinic has no way to know it was never meant to be read.
    expect(asCenter('draft')).toBe(false);
    expect(asCenter('signed')).toBe(true);
    expect(asCenter('verified')).toBe(true);
    expect(asCenter('amended')).toBe(true);
  });

  it('lets the author see their own draft and nobody else can see it', () => {
    expect(asCenter('draft', 'center_staff', 7)).toBe(true);
    expect(asCenter('draft', 'typist', 20)).toBe(false);
  });

  it('lets a colleague read anything that carries a signature, and nothing that does not', () => {
    // The second name is never the holder of the case, so a reviewer who could not open a
    // report could not do the job the two-signature rule asks of them. A draft is the
    // exception: it has no signature yet, and it is nobody's to read.
    expect(asCenter('draft', 'radiologist')).toBe(false);
    expect(asCenter('signed', 'reviewer')).toBe(true);
    expect(asCenter('amended', 'radiologist')).toBe(true);
  });

  it('closes a withdrawn draft to everyone but its author and the platform', () => {
    expect(asCenter('withdrawn', 'radiologist')).toBe(false);
    expect(asCenter('withdrawn', 'radiologist', 7)).toBe(true);
  });

  it('lets the platform roles read anything', () => {
    expect(asCenter('withdrawn', 'owner')).toBe(true);
    expect(asCenter('draft', 'console')).toBe(true);
  });
});

describe('deliverDecision', () => {
  // Every case starts with no open critical loop, because that is the ordinary report and a
  // test that had to spell it out each time would bury the four rules that differ.
  const clean = { requiresReviewer: false, hasReviewer: false, openCriticals: 0 };

  it('refuses a draft, because there is nothing signed to hand over', () => {
    expect(deliverDecision({ state: 'draft', ...clean }))
      .toEqual({ ok: false, reason: 'not_signed' });
  });

  it('refuses a report that has already gone out', () => {
    // `not_signed` would be the lazy answer and it would be a lie: the report is signed,
    // it is delivered, and an operator reading "not signed" would go looking for a reader.
    expect(deliverDecision({ state: 'delivered', requiresReviewer: true, hasReviewer: true, openCriticals: 0 }))
      .toEqual({ ok: false, reason: 'already_delivered' });
  });

  it('enforces the second name at the door the patient data leaves through', () => {
    // A signed report on a sub-specialty that requires review cannot reach the clinic until
    // a reviewer is named. The reader who signed it is not blocked — they sign and go home.
    expect(deliverDecision({ state: 'signed', requiresReviewer: true, hasReviewer: false, openCriticals: 0 }))
      .toEqual({ ok: false, reason: 'review_required' });
    expect(deliverDecision({ state: 'signed', requiresReviewer: true, hasReviewer: true, openCriticals: 0 })).toEqual({ ok: true });
    expect(deliverDecision({ state: 'verified', requiresReviewer: true, hasReviewer: true, openCriticals: 0 })).toEqual({ ok: true });
  });

  it('refuses to release a document carrying a finding nobody has acknowledged', () => {
    // The order matters: a cleared second name does not make an unacknowledged pneumothorax
    // safe to drop into a portal, so this check runs last and is the one still standing.
    expect(deliverDecision({ state: 'verified', requiresReviewer: true, hasReviewer: true, openCriticals: 1 }))
      .toEqual({ ok: false, reason: 'critical_unacknowledged' });
    expect(deliverDecision({ state: 'signed', ...clean, openCriticals: 2 }))
      .toEqual({ ok: false, reason: 'critical_unacknowledged' });
  });

  it('answers the more urgent gap first when a report carries both', () => {
    expect(deliverDecision({ state: 'signed', requiresReviewer: true, hasReviewer: false, openCriticals: 1 }))
      .toEqual({ ok: false, reason: 'review_required' });
  });

  it('lets a sub-specialty that does not require review deliver on one signature', () => {
    expect(deliverDecision({ state: 'signed', ...clean })).toEqual({ ok: true });
  });
});

describe('needsSecondName', () => {
  it('names the gap only for a report that is waiting on it', () => {
    const waiting = { state: 'signed' as ReportState, requiresReviewer: true, hasReviewer: false };
    expect(needsSecondName(waiting)).toBe(true);
    expect(needsSecondName({ ...waiting, hasReviewer: true })).toBe(false);
    expect(needsSecondName({ ...waiting, requiresReviewer: false })).toBe(false);
    expect(needsSecondName({ ...waiting, state: 'verified' })).toBe(false);
    // An amended row is history, not a live gap: the current answer is a different row.
    expect(needsSecondName({ ...waiting, state: 'amended' })).toBe(false);
  });
});

describe('deliveryIdempotencyKey', () => {
  it('keys on the version, so an amendment is never swallowed', () => {
    const a = deliveryIdempotencyKey({ reportId: 9, version: 1, channel: 'portal' });
    const b = deliveryIdempotencyKey({ reportId: 9, version: 2, channel: 'portal' });
    expect(a).toBe('report:9:v1:portal');
    expect(a).not.toBe(b);
    expect(deliveryIdempotencyKey({ reportId: 9, version: 1, channel: 'email' })).not.toBe(a);
  });
});
