/**
 * The operator's digest: the alerts the sweeps write, read back out of the audit log and put
 * in front of a person.
 *
 * Every sweep raises its alerts as audit rows — a dispatch ladder that ended, an SLA clock
 * that breached, a critical finding nobody acknowledged, a report waiting too long for a
 * second name, a notification that was refused or gave up. The rows are tamper-evident and
 * complete, which is right for evidence and useless for attention: nobody reads an audit log
 * at 2 a.m. So one address receives a bounded, periodic reading of those rows. The cadence is
 * the design rather than a limitation — these are operational debts that need a human, not
 * clinical emergencies, and a mailer that fires one message per row teaches its recipient to
 * filter the address.
 */

export type OpsDigestRow = {
  id: number;
  occurredAt: Date;
  action: string;
  entity: string;
  entityId: string | null;
  detail: Record<string, unknown> | null;
};

/**
 * The only detail keys the digest will print, in the order it prints them.
 *
 * `detail` is jsonb and its keys are whatever the writing sweep chose, so the control is the
 * shape of the input rather than a scrub run over prose — the same discipline as the
 * report-ready message, because a filter over arbitrary output only has to miss once. A key
 * that is not listed here never reaches the wire, even if a sweep starts writing one
 * tomorrow: a patient name that somebody adds to a detail object is absent from the mail, not
 * filtered out of it at send time.
 */
export const DETAIL_KEYS = [
  'studyId', 'reportId', 'accession', 'channel', 'recipient', 'conditionCode',
  'receiverName', 'priority', 'reason', 'errorCode', 'attemptNo', 'waitingMinutes', 'slaMinutes',
] as const;

/**
 * One audit row as one line.
 *
 * Only primitive values print. `gap` on a dispatch row is an object whose `reason` already
 * carries the useful summary, and a JSON dump inside a line-shaped digest is noise — the
 * audit row remains the place to read the full structure.
 */
export function opsDigestLine(row: OpsDigestRow): string {
  const parts = [
    row.occurredAt.toISOString(),
    row.action,
    row.entityId === null ? row.entity : `${row.entity}#${row.entityId}`,
  ];
  for (const key of DETAIL_KEYS) {
    const value = row.detail?.[key];
    const primitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!primitive) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}

export function opsDigestSubject(alerts: number, sinceIso: string | null): string {
  const noun = alerts === 1 ? 'alert' : 'alerts';
  return `[telrad] ${alerts} ops ${noun}${sinceIso ? ` since ${sinceIso}` : ' since startup'}`;
}

/**
 * Plain text, for the same reason the report-ready message is: no HTML render guarantee on
 * whatever machine an operator is reading at the hour they are reading it.
 */
export function opsDigestBody(rows: OpsDigestRow[], sinceIso: string | null): string {
  const lines = [
    `The telrad sweeps wrote ${rows.length} alert ${rows.length === 1 ? 'row' : 'rows'} since the last digest`
      + `${sinceIso ? ` (${sinceIso})` : ' (none has been sent before)'}.`,
    '',
    ...rows.map((row) => opsDigestLine(row)),
    '',
    'Each line is one audit row. The audit log, not this message, is the record: the rows are',
    'hash-chained, and this digest being late or lost does not change them. Details are printed',
    'through a fixed key whitelist, so nothing here can carry a patient name even if a sweep',
    'starts writing one.',
    '',
    '— sent by telrad ops digest. Do not reply to this address.',
  ];
  return lines.join('\n');
}
