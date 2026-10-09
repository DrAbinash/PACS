import { mayAmend, reviewerMayClear, type Grade, type ReportState } from './enums.js';

/**
 * The report lifecycle as arithmetic rather than as prose in a route handler. Both the
 * api (which must refuse) and the web (which must grey out) call these, so a reader
 * cannot be shown a "Sign" button that the server then rejects for a reason the screen
 * already knew.
 */

export const REPORT_SECTIONS = [
  'clinicalHistory',
  'technique',
  'findings',
  'impression',
  'recommendation',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

// Only these two have to carry words before a signature is allowed. The reason is the
// specific failure a busy night produces: Findings gets typed out, Impression stays
// empty, and two names end up on a document that says nothing. A center reading a blank
// impression cannot tell "normal" from "the reader ran out of time", and will assume the
// kinder one.
export const REQUIRED_SECTIONS: readonly ReportSection[] = ['findings', 'impression'];

export type ReportAction = 'edit' | 'sign' | 'countersign' | 'amend' | 'withdraw';

// A signed report is immutable, and `amend` is the only way to change what a reader
// thinks: the previous row keeps both its names and its timestamps, and a new version
// supersedes it. `withdraw` exists for an abandoned draft so it can be closed without
// deleting it — a row that never existed answers no audit question.
const ALLOWED: Record<ReportAction, readonly ReportState[]> = {
  edit: ['draft'],
  sign: ['draft'],
  countersign: ['signed'],
  amend: ['signed', 'verified', 'delivered'],
  withdraw: ['draft'],
};

export function stateAllows(action: ReportAction, state: ReportState): boolean {
  return ALLOWED[action].includes(state);
}

export function isBlank(value: string | null | undefined): boolean {
  // Whitespace-only is blank. A single newline in an Impression field passes through a
  // required-field check that only tests for null, and it prints as an empty section.
  return value === null || value === undefined || value.trim() === '';
}

export function sectionText(
  sections: Record<string, string> | null | undefined,
  name: ReportSection,
): string {
  return sections?.[name] ?? '';
}

export function missingSections(sections: Record<string, string> | null | undefined): ReportSection[] {
  return REQUIRED_SECTIONS.filter((name) => isBlank(sectionText(sections, name)));
}

export type Decision = { ok: true } | { ok: false; reason: string };

const refused = (reason: string): Decision => ({ ok: false, reason });

export function signDecision(input: {
  state: ReportState;
  sections: Record<string, string> | null;
}): Decision {
  if (!stateAllows('sign', input.state)) return refused('not_a_draft');
  const missing = missingSections(input.sections);
  if (missing.length > 0) return refused('sections_blank:' + missing.join(','));
  return { ok: true };
}

/**
 * A countersignature is a second *name*, which means three separate refusals that are
 * easy to collapse into one if you are not careful: the same person cannot review their
 * own work, a reviewer needs a recorded grade to review at all, and the grade has to be
 * at least the author's. The database enforces the first of these as a CHECK
 * (`reports_not_self_review`); this enforces it before the insert, because a check
 * violation arrives as a 500 with no explanation.
 */
export function countersignDecision(input: {
  state: ReportState;
  authorUserId: number;
  reviewerUserId: number;
  authorGrade: Grade | null;
  reviewerGrade: Grade | null;
}): Decision {
  if (!stateAllows('countersign', input.state)) return refused('not_signed');
  if (input.authorUserId === input.reviewerUserId) return refused('self_review');
  if (!input.reviewerGrade) return refused('reviewer_has_no_grade');
  if (!input.authorGrade) return refused('author_has_no_grade');
  if (!reviewerMayClear(input.authorGrade, input.reviewerGrade)) return refused('grade_below_author');
  return { ok: true };
}

/**
 * Stricter than the countersignature rule on purpose: the person correcting a signed
 * report must outrank the one who signed it, because a self-correction is
 * indistinguishable from an unreviewed edit once both are in the same table.
 */
export function amendDecision(input: {
  state: ReportState;
  reason: string | null | undefined;
  authorGrade: Grade | null;
  amenderGrade: Grade | null;
}): Decision {
  if (!stateAllows('amend', input.state)) return refused('not_signed');
  if (isBlank(input.reason)) return refused('reason_required');
  if (!input.amenderGrade) return refused('amender_has_no_grade');
  if (!input.authorGrade) return refused('author_has_no_grade');
  if (!mayAmend(input.authorGrade, input.amenderGrade)) return refused('grade_not_above_author');
  return { ok: true };
}

export function nextVersion(versions: number[]): number {  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

export type ReportVersion = { version: number; state: ReportState };
/**
 * The one row a center should be looking at. Every earlier version is `amended` or
 * `withdrawn`, so this cannot return two answers — and if it ever does, the answer is
 * the newest, because a superseded document must not be the one on screen.
 */
export function currentVersion<T extends ReportVersion>(rows: T[]): T | null {
  const live = rows.filter((r) => r.state !== 'amended' && r.state !== 'withdrawn');
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.version > a.version ? b : a));
}

const PLATFORM_ROLES = ['owner', 'console'];
// What anybody who is not the author may see. A draft is not on this list, and it does not
// matter who is asking: a half-written impression reaching a colleague or the referring
// clinic is how "question of a perforation" gets read as a diagnosis, and the reader who
// left it open never agreed to be quoted. An amendment and a withdrawal stay readable
// because they are the record of what was said and when.
const PUBLISHED: readonly ReportState[] = ['signed', 'verified', 'delivered', 'amended'];

/**
 * Who may read a report. Wider than the pixels, which need an assignment or a stated
 * relation to the document: a reviewer is the second name by definition, so they are never
 * the holder of the case, and one live lock per study is a routing rule that must not be
 * broken just to let a review happen. The compensating control is that every read is
 * audited, and that a role nobody thought about — `typist`, desk staff — falls through to
 * the published set rather than being handed a name in the list.
 */
export function mayReadReport(input: {
  state: ReportState;
  authorUserId: number;
  readerUserId: number;
  readerRole: string;
}): boolean {
  if (PLATFORM_ROLES.includes(input.readerRole)) return true;
  if (input.authorUserId === input.readerUserId) return true;
  return PUBLISHED.includes(input.state);
}
