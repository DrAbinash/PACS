import type { Decision } from './report.js';

/**
 * The critical-finding loop, as a closed set of rules rather than a string in a route.
 *
 * A critical result is not finished when the reader writes it; it is finished when a named
 * human at the referring side says they have heard it. Everything else in this file exists
 * to keep those two facts apart: `notifiedAt` is when the reader *says* they told somebody,
 * `acknowledgedAt` is when somebody says they heard, and the gap between them is the number
 * a radiology service is judged on at 2 a.m. — not the report turnaround, which signing
 * already measures.
 *
 * The list is closed on purpose. Matching the impression text against a condition list was
 * the tempting build and it was rejected: a confident false positive at 2 a.m. trains the
 * referring clinician to ignore the alert, and a missed one is the patient. So the reader
 * declares, in words, from this list, and the system records who they told.
 */

export type CriticalChannel = 'phone' | 'sms' | 'whatsapp' | 'portal' | 'email';

export const CRITICAL_CHANNELS: readonly CriticalChannel[] = [
  'phone', 'sms', 'whatsapp', 'portal', 'email',
];

// Voice-and-text channels need a number to have been given to; `portal` and `email` are
// records of where the finding was *left*, which is a different act and does not imply
// anybody was reached.
const REACHABLE: readonly CriticalChannel[] = ['phone', 'sms', 'whatsapp'];

export type CriticalCondition = {
  code: string;
  label: string;
  /** Minutes allowed between the reader telling somebody and that person acknowledging. */
  slaMinutes: number;
};

// A short, explicit list, ordered so the findings a neurosurgical service wants awake for are
// the first ones a reader sees. Every entry is something a referring clinician would want to be
// told about rather than read about in the morning, and the minute figures are the ones a
// service contract argues about rather than invents at the desk.
export const CRITICAL_CONDITIONS: readonly CriticalCondition[] = [
  { code: 'intracranial-haemorrhage', label: 'Acute intracranial haemorrhage', slaMinutes: 10 },
  { code: 'subarachnoid-haemorrhage', label: 'Aneurysmal subarachnoid haemorrhage', slaMinutes: 10 },
  { code: 'large-vessel-occlusion', label: 'Acute ischaemic stroke with large-vessel occlusion', slaMinutes: 10 },
  { code: 'cerebral-herniation', label: 'Cerebral herniation or acute mass effect', slaMinutes: 10 },
  { code: 'cord-compression', label: 'Spinal cord or cauda equina compression', slaMinutes: 30 },
  { code: 'pneumothorax', label: 'Pneumothorax', slaMinutes: 10 },
  { code: 'pulmonary-embolism', label: 'Pulmonary embolism', slaMinutes: 10 },
  { code: 'aortic-dissection', label: 'Suspected aortic dissection', slaMinutes: 10 },
  { code: 'cardiac-tamponade', label: 'Cardiac tamponade or haemopericardium', slaMinutes: 10 },
  { code: 'pneumoperitoneum', label: 'Free intraperitoneal air', slaMinutes: 10 },
  { code: 'airway-obstruction', label: 'Airway obstruction or retained foreign body', slaMinutes: 10 },
  { code: 'strangulated-hernia', label: 'Bowel obstruction with strangulation', slaMinutes: 30 },
  { code: 'ruptured-ectopic-pregnancy', label: 'Ruptured ectopic pregnancy', slaMinutes: 10 },
  { code: 'testicular-torsion', label: 'Testicular torsion', slaMinutes: 30 },
  { code: 'non-accidental-injury', label: 'Suspicion of non-accidental injury', slaMinutes: 60 },
  { code: 'suspected-malignancy', label: 'Previously unknown suspected malignancy', slaMinutes: 1440 },
  { code: 'other', label: 'Another finding the reader judges critical', slaMinutes: 30 },
];

export function criticalCondition(code: string | null | undefined): CriticalCondition {
  if (code) {
    const hit = CRITICAL_CONDITIONS.find((c) => c.code === code);
    if (hit) return hit;
  }
  // An unknown code has to stay visible rather than vanish into a default: the board shows
  // the word that was stored, and a row rendered as "Other" would be a lie about what the
  // reader actually recorded.
  return { code: code ?? 'unknown', label: 'Critical finding (code not in catalogue)', slaMinutes: 30 };
}

const refused = (reason: string): Decision => ({ ok: false, reason });

/** A name is a name only if there are characters in it; a submitted-but-empty field is not. */
const hasText = (value: string | null | undefined): boolean => (value?.trim() ?? '') !== '';

/**
 * What the reader has to have said for a critical event to exist. Each refusal is separate
 * because each one is a different thing to fix at the desk: an unknown code is a typo, a
 * missing receiver name is nobody being told, and a phone channel without a number is a
 * claim that cannot be checked later.
 */
export function declareDecision(input: {
  condition: string | null | undefined;
  channel: string | null | undefined;
  receiverName: string | null | undefined;
  receiverPhone: string | null | undefined;
  detail: string | null | undefined;
}): Decision {
  const condition = CRITICAL_CONDITIONS.find((c) => c.code === input.condition);
  if (!condition) return refused('unknown_condition');
  if (!input.channel || !CRITICAL_CHANNELS.includes(input.channel as CriticalChannel)) {
    return refused('channel_required');
  }
  if (!hasText(input.receiverName)) return refused('receiver_name_required');
  if (REACHABLE.includes(input.channel as CriticalChannel) && !hasText(input.receiverPhone)) {
    return refused('phone_required_for_channel');
  }
  // `other` is the only entry with no label worth reading on its own, so it has to carry the
  // words; otherwise the board would show "Other — critical" and nobody could act on it.
  if (condition.code === 'other' && !hasText(input.detail)) return refused('detail_required');
  return { ok: true };
}

/**
 * An acknowledgement is recorded, not inferred: the desk or the reader types who said it.
 * Re-acknowledging is refused rather than ignored, because the timestamp of the *first*
 * acknowledgement is the number the SLA is measured against and a second one would rewrite it.
 */
export function ackDecision(input: {
  alreadyAcknowledged: boolean;
  acknowledgedByName: string | null | undefined;
}): Decision {
  if (input.alreadyAcknowledged) return refused('already_acknowledged');
  if (!hasText(input.acknowledgedByName)) return refused('receiver_name_required');
  return { ok: true };
}

export type CriticalClock = {
  notifiedAt: Date;
  slaMinutes: number;
  acknowledgedAt: Date | null;
};

export function criticalDeadline(clock: CriticalClock): Date {
  return new Date(clock.notifiedAt.getTime() + clock.slaMinutes * 60_000);
}

export type CriticalState = 'acknowledged' | 'waiting' | 'breached';

/**
 * Three answers, and no fourth. `waiting` is inside the window and is not an alarm; the
 * board shows it so the desk can see the loop is open, and only `breached` is a number
 * somebody is asked about afterwards. A late acknowledgement does not move the event back
 * to `waiting` — it stays late, and `late` says by how much.
 */
export function criticalState(clock: CriticalClock, now: Date): CriticalState {
  if (clock.acknowledgedAt !== null) return 'acknowledged';
  return now.getTime() > criticalDeadline(clock).getTime() ? 'breached' : 'waiting';
}

export function minutesToAckDeadline(clock: CriticalClock, now: Date): number {
  return Math.round((criticalDeadline(clock).getTime() - now.getTime()) / 60_000);
}

/** True when the acknowledgement landed after the deadline it was supposed to meet. */
export function acknowledgedLate(clock: CriticalClock): boolean {
  return clock.acknowledgedAt !== null
    && clock.acknowledgedAt.getTime() > criticalDeadline(clock).getTime();
}

/**
 * The one line the board, the report panel and the delivered document all print. They share
 * it because the document a clinic receives and the row an operator chases have to say the
 * same words about the same finding, or the audit trail becomes two stories.
 */
export function criticalText(
  code: string | null | undefined,
  detail: string | null | undefined,
): string {
  const note = (detail ?? '').trim();
  return note === '' ? criticalCondition(code).label : `${criticalCondition(code).label} — ${note}`;
}
