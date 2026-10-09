import type { Decision } from './report.js';

/**
 * The notification outbox: what gets queued when a report leaves, how many times it is tried,
 * and what the message is allowed to say.
 *
 * Two rules hold this together. The first is that a queue is only useful if a retry cannot
 * quietly become a duplicate, so every message has an idempotency key and a bounded number of
 * attempts before it goes `dead` and somebody is told. The second is the one that decides
 * whether this product can hold patient data at all: **an email is not a portal.** Messages sit
 * in forwarded inboxes, on phones that are not the clinic's, and in mail-server logs that
 * nobody audits. So the message is built from a type that has no field for a patient name, an
 * identifier, a date of birth or a finding — the control is the shape of the input, not a
 * scrub run over somebody's prose afterwards.
 */

export type DeliveryChannel = 'portal' | 'email' | 'whatsapp' | 'hl7' | 'pdf_link';

// Five tries, then the row stops being a queue item and becomes a finding. Chosen because the
// common SMTP failures are transient for minutes (a relay greylisting, a full mailbox, a NAS
// whose network came back late) and permanent after that (an address that does not exist), and
// the difference between those two is worth about an hour of trying.
export const MAX_NOTIFY_ATTEMPTS = 5;

// Minutes before the next try, indexed by the attempt that just failed. Growing rather than
// fixed: a relay that is down for an hour should not be hit forty times by three queues' worth
// of backoff, and a shared NAS has no business spending its evening doing that.
const BACKOFF_MINUTES = [1, 5, 30, 120, 480];

export function backoffMinutes(attemptNo: number): number {
  const index = Math.min(Math.max(attemptNo, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] ?? 480;
}

export type OutboxRow = {
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attemptNo: number;
  nextAttemptAt: Date | null;
};

/**
 * Whether a queued row may be attempted now.
 *
 * `sent` and `dead` are terminal, and a row that is not due yet is left alone rather than
 * fetched and skipped — the worker's query and this function have to agree, because the query
 * is what keeps the queue from growing with everything it has ever failed to send.
 */
export function mayAttempt(row: OutboxRow, now: Date): boolean {
  if (row.status === 'sent' || row.status === 'dead') return false;
  if (row.nextAttemptAt === null) return true;
  return row.nextAttemptAt.getTime() <= now.getTime();
}

export type AttemptOutcome = {
  status: 'sent' | 'failed' | 'dead';
  attemptNo: number;
  nextAttemptAt: Date | null;
  errorCode: string | null;
};

/**
 * What a delivery attempt leaves behind.
 *
 * The last attempt does not leave a `failed` row waiting for a retry that will never come: it
 * goes `dead`, which is the state a person has to look at. A row that quietly stays `failed`
 * with no next attempt is how a clinic ends up never being told, three weeks later.
 */
export function afterAttempt(input: {
  attemptNo: number;
  ok: boolean;
  errorCode?: string | null;
  now: Date;
}): AttemptOutcome {
  if (input.ok) {
    return { status: 'sent', attemptNo: input.attemptNo, nextAttemptAt: null, errorCode: null };
  }
  const exhausted = input.attemptNo >= MAX_NOTIFY_ATTEMPTS;
  return {
    status: exhausted ? 'dead' : 'failed',
    attemptNo: input.attemptNo,
    nextAttemptAt: exhausted ? null : new Date(input.now.getTime()
      + backoffMinutes(input.attemptNo) * 60_000),
    errorCode: input.errorCode ?? 'send_failed',
  };
}

/**
 * An address, or nothing.
 *
 * Deliberately not a specification: the RFC-for-valid-address grammar rejects perfectly usable
 * clinic addresses (`dr.rao@govhosp.gov.in` with a local part full of dots and hyphens) and
 * accepts nonsense. What this rule is for is the two things that actually happen at a desk —
 * somebody typing `na` into the field, and somebody pasting a name and an address together —
 * and the answer when it does not look like an address is `null`, which queues nothing rather
 * than failing the save. A center's referral record is not going to be blocked by a
 * notification feature it does not use.
 */
export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  const split = value.lastIndexOf('@');
  if (split < 1 || split === value.length - 1) return null;
  const local = value.slice(0, split);
  const domain = value.slice(split + 1);
  // The `@` test belongs on the local part: `split` is the *last* one, so anything earlier is
  // a second address pasted into the field rather than a separator.
  if (local.includes('@') || /\s/.test(value)) return null;
  if (!domain.includes('.') || /^\.|\.$|\.\./.test(domain)) return null;
  return value;
}

/** A row that has already gone `dead` is not retried, and enqueuing over one is refused. */
export function enqueueDecision(row: OutboxRow | null): Decision {
  if (row === null) return { ok: true };
  if (row.status === 'sent') return { ok: false, reason: 'already_sent' };
  if (row.status === 'dead') return { ok: false, reason: 'already_dead' };
  return { ok: true };
}

/**
 * The only fields a notification may be built from.
 *
 * There is deliberately no patient name, MRN, date of birth, gender, study date, accession
 * *with* clinical detail, or report text in here. A referring clinician needs to know that the
 * answer to a referral they made exists and where to read it; they do not need it in a message
 * that outlives the session. The accession is included because it is the key the clinic wrote
 * on its own request form, and it is the only way the message is actionable without a login.
 */
export type ReportReadyMessage = {
  centreName: string;
  tenantCode: string;
  accession: string;
  reportVersion: number;
  signedAt: string | null;
  /**
   * Whether a second name is actually on the document — not whether the sub-specialty demands
   * one. The rule and the fact come apart the moment a tenant switches the rule off to release
   * a case, and a message that reports the rule as a signature tells a clinic something about a
   * clinical document that is not true.
   */
  hasSecondSignature: boolean;
  portalUrl: string;
};

export function reportReadySubject(input: ReportReadyMessage): string {
  return `Report ready — ${input.accession} (version ${input.reportVersion})`;
}

/**
 * Plain text, because a clinic opening this on a shared reception machine gets no HTML render
 * guarantee and an unstyled message is the one format that never surprises anybody.
 */
export function reportReadyBody(input: ReportReadyMessage): string {
  const lines = [
    `A radiology report from ${input.centreName} has been released for referral ${input.accession}.`,
    `Version ${input.reportVersion}${input.signedAt ? `, signed ${input.signedAt}` : ''}.`,
    input.hasSecondSignature
      ? 'This report carries two signatures.'
      : 'This report carries one signature.',
    '',
    'Read it in the portal: ' + input.portalUrl,
    '',
    'This message contains no clinical information and no patient identifiers other than the',
    'referral number above. The report itself is only available to signed-in users of the',
    `portal for ${input.tenantCode}.`,
    '',
    '— sent by telrad on behalf of a radiology service. Do not reply to this address.',
  ];
  return lines.join('\n');
}

/**
 * The assertion the transport makes before it puts anything on a wire.
 *
 * It is written as a function rather than as a test only because the body is assembled from an
 * input type that could grow: if somebody adds a patient name to `ReportReadyMessage` and
 * prints it, this refuses the send rather than mailing the name. Cheap, and the kind of guard
 * that has to be in the path rather than beside it.
 */
export function containsNoPatientIdentifiers(
  text: string,
  forbidden: (string | null | undefined)[],
): boolean {
  const haystack = text.toLowerCase();
  return forbidden
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 2)
    .every((v) => !haystack.includes(v.trim().toLowerCase()));
}
