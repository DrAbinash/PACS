export const PRIORITIES = ['stat', 'urgent', 'routine'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LINK_STATES = ['linked', 'orphan', 'ambiguous', 'unlinked_read_only'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const ASSIGNMENT_STATES = [
  'offered', 'accepted', 'reading', 'returned', 'completed', 'reassigned',
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const LIVE_ASSIGNMENT_STATES = ['offered', 'accepted', 'reading'] as const;

export const REPORT_STATES = [
  'draft', 'signed', 'verified', 'delivered', 'amended', 'withdrawn',
] as const;
export type ReportState = (typeof REPORT_STATES)[number];

// Grade ordering is what makes the countersignature rule computable: a reviewer
// may only clear a report whose author is at or below their own grade. It is an
// operator-configured record of a certificate, not a legal determination.
export const GRADE_RANK = { junior: 1, senior: 2, chief: 3 } as const;
export type Grade = keyof typeof GRADE_RANK;

export function reviewerMayClear(authorGrade: Grade, reviewerGrade: Grade): boolean {
  return GRADE_RANK[reviewerGrade] >= GRADE_RANK[authorGrade];
}

// An amendment is signed by someone at strictly higher grade than the author of
// the version being corrected. Deliberately stricter than the countersignature
// rule, and the reason it exists is that a self-correction is indistinguishable
// from an unreviewed edit in an audit.
export function mayAmend(authorGrade: Grade, amenderGrade: Grade): boolean {
  return GRADE_RANK[amenderGrade] > GRADE_RANK[authorGrade];
}

// The critical-finding catalogue lives in `criticals.ts`, where each code carries the label a
// desk reads and the acknowledgement window it promised.

export const NIGHT_WINDOW = { startHour: 23, endHour: 7 } as const;

// tzOffsetMinutes is east-positive, so India is 330. Kept as a number rather than
// an IANA name because the night window is a contract term per tenant, and a
// tenant's contract states hours, not a zone database identifier.
export function isNight(at: Date, tzOffsetMinutes: number): boolean {
  const local = new Date(at.getTime() + tzOffsetMinutes * 60_000);
  const h = local.getUTCHours();
  return h >= NIGHT_WINDOW.startHour || h < NIGHT_WINDOW.endHour;
}
