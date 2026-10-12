import { opsDigestBody, opsDigestSubject, type OpsDigestRow } from '@telrad/shared';
import type { NotifyTransport } from './notify.js';

/**
 * The alert actions the digest reads back, and nothing else.
 *
 * Deliberately narrow. 'sla.escalated' fires on every priority bump and would make the digest
 * the noise it exists to prevent; 'dispatch.case_released' is the system healing itself — a
 * stale lock returned to the pool needs no page. Everything here is a case or a message that a
 * human has to act on, and nothing here can be fixed by waiting.
 */
export const OPS_ALERT_ACTIONS = [
  'dispatch.exhausted',
  'sla.breached',
  'critical.breached',
  'review.waiting_long',
  'notify.dead',
  'notify.refused',
] as const;

/**
 * The audit row a digest attempt writes — including a failed one, which is evidence ("we
 * tried to tell you at T and the relay refused") and the thing that paces the next retry at
 * digest frequency rather than tick frequency. The name is neutral because the row does not
 * imply the mail arrived; `detail.ok` says that.
 */
export const DIGEST_ACTION = 'ops.digest';

/**
 * What the digest knows about itself, read from the audit log.
 *
 * The cursor is the last audit id the operator was actually told about — it only moves when a
 * send succeeds. `lastAttemptAt` is the latest attempt of any kind, because a failed attempt
 * still just happened and retrying it ten seconds later is how a dead relay gets hit forty
 * times in an hour.
 */
export type OpsDigestState = {
  cursor: number;
  cursorAt: Date | null;
  lastAttemptAt: Date | null;
};

export type DigestRecord = {
  ok: boolean;
  lastAuditId: number | null;
  alerts: number;
};

export type OpsPort = {
  alertsSince(sinceAuditId: number, limit: number): Promise<OpsDigestRow[]>;
  digestState(): Promise<OpsDigestState>;
  recordDigest(record: DigestRecord): Promise<void>;
};

export type DigestOutcome = {
  alerts: number;
  sent: boolean;
  held: boolean;
  cursor: number;
};

/**
 * One digest pass: read the alerts since the cursor, mail them, write down what happened.
 *
 * The interval gate is checked before anything is read, so a quiet hour costs one query and a
 * hot hour does not read the same rows forty times. A failed send records the attempt but
 * keeps the cursor, so the next interval re-mails the same alerts rather than considering
 * them told; the worst case after a relay outage is one duplicate, never a lost alert.
 */
export async function opsDigestOnce(
  port: OpsPort,
  transport: NotifyTransport,
  opts: { to: string | null; now: Date; intervalMs?: number; limit?: number },
): Promise<DigestOutcome> {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const limit = opts.limit ?? 200;
  if (!transport.configured || opts.to === null || opts.to.trim() === '') {
    return { alerts: 0, sent: false, held: false, cursor: 0 };
  }
  const state = await port.digestState();
  if (state.lastAttemptAt !== null
    && opts.now.getTime() - state.lastAttemptAt.getTime() < intervalMs) {
    return { alerts: 0, sent: false, held: true, cursor: state.cursor };
  }
  const rows = await port.alertsSince(state.cursor, limit);
  if (rows.length === 0) {
    return { alerts: 0, sent: false, held: false, cursor: state.cursor };
  }
  // "Since" in the subject is when the last successful digest went out — the moment the
  // operator was last actually told — not the cursor id, which is bookkeeping a human
  // cannot read.
  const sinceIso = state.cursor > 0 && state.cursorAt !== null
    ? state.cursorAt.toISOString()
    : null;
  const last = rows.at(-1);
  if (last === undefined) {
    return { alerts: 0, sent: false, held: false, cursor: state.cursor };
  }
  const lastId = last.id;
  const send = await transport.send({
    to: opts.to,
    subject: opsDigestSubject(rows.length, sinceIso),
    text: opsDigestBody(rows, sinceIso),
  });
  await port.recordDigest({ ok: send.ok, lastAuditId: send.ok ? lastId : null, alerts: rows.length });
  return { alerts: rows.length, sent: send.ok, held: false, cursor: send.ok ? lastId : state.cursor };
}
