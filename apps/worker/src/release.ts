import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { appendAudit, assignments, readerAvailability } from '@telrad/db';
import { IDLE_SECONDS } from '@telrad/shared';

// A reader who accepted a case and then closed their laptop is the exact failure the
// heartbeat exists to catch. The offer-expiry timer handles the "nobody answered" case;
// this sweep handles the "somebody answered and then disappeared" case — the one that
// turns a five-minute STAT into a forty-five-minute surprise when the next dispatcher
// tick finally sees the reader is gone.

// Only accepted and reading are released. Offered cases have their own expiry timer, and
// a completed case is already signed. Releasing a reading case matters: a reader who went
// dark mid-read is the same operational gap as one who never accepted, and the next
// dispatch tick cannot re-offer a study that still holds a live lock.
const RELEASE_STATES = ['accepted', 'reading'] as const;

export type ReleasePort = {
  stale(now: Date): Promise<StaleAssignment[]>;
  release(assignmentId: number, reason: string, now: Date): Promise<boolean>;
  audit(input: {
    actorUserId: number | null;
    tenantId: number;
    action: string;
    entityId: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
};

export type StaleAssignment = {
  assignmentId: number;
  studyId: number;
  tenantId: number;
  clinicianUserId: number;
  state: string;
  readerState: string;
  lastSeenAt: Date | null;
  sinceSeenSeconds: number | null;
};

export type ReleaseResult = {
  checked: number;
  released: number;
  byReason: Record<string, number>;
};

export function createReleaseStore(db: Db): ReleasePort {
  return {
    async stale(now) {
      const idleCutoff = new Date(now.getTime() - IDLE_SECONDS * 1000);

      const rows = await db.select({
        assignmentId: assignments.id,
        studyId: assignments.studyId,
        tenantId: assignments.tenantId,
        clinicianUserId: assignments.clinicianUserId,
        state: assignments.state,
        readerState: readerAvailability.state,
        lastSeenAt: readerAvailability.lastSeenAt,
      }).from(assignments)
        .innerJoin(readerAvailability, eq(readerAvailability.userId, assignments.clinicianUserId))
        .where(and(
          inArray(assignments.state, [...RELEASE_STATES]),
          // Two ways a reader is gone: they declared it (state offline/away) or the
          // heartbeat stopped (last_seen_at older than the idle threshold). Either way
          // the case is stuck, and the sweep releases it without waiting for the reader
          // to come back and decline it by hand.
          sql`(
            ${readerAvailability.state} IN ('offline', 'away')
            OR ${readerAvailability.lastSeenAt} < ${idleCutoff.toISOString()}::timestamptz
            OR ${readerAvailability.lastSeenAt} IS NULL
          )`,
        ))
        .limit(50);

      return rows.map((row) => {
        const sinceSeenSeconds = row.lastSeenAt
          ? Math.max(0, Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000))
          : null;
        return {
          assignmentId: row.assignmentId,
          studyId: row.studyId,
          tenantId: row.tenantId,
          clinicianUserId: row.clinicianUserId,
          state: row.state,
          readerState: row.readerState,
          lastSeenAt: row.lastSeenAt,
          sinceSeenSeconds,
        } satisfies StaleAssignment;
      });
    },

    async release(assignmentId, reason, now) {
      // Conditional update: the live-lock unique index means a concurrent dispatch that
      // already moved this assignment (accepted, started reading, or completed) must not
      // be overwritten by a sweep that read stale presence data.
      const rows = await db.execute<{ id: number }>(sql`
        update telrad.assignments
           set state = 'returned', returned_at = ${now.toISOString()}::timestamptz, return_reason = ${reason}
         where id = ${assignmentId}
           and state in ('accepted', 'reading')
        returning id`);
      return rows.length > 0;
    },

    async audit(input) {
      await appendAudit(db, {
        actorUserId: input.actorUserId,
        actorKind: 'system',
        tenantId: input.tenantId,
        action: input.action,
        entity: 'assignments',
        entityId: input.entityId,
        detail: input.detail,
      });
    },
  };
}

export async function releaseSweepOnce(
  port: ReleasePort,
  opts: { now?: () => Date } = {},
): Promise<ReleaseResult> {
  const now = (opts.now ?? (() => new Date()))();
  const r: ReleaseResult = { checked: 0, released: 0, byReason: {} };

  const stale = await port.stale(now);
  r.checked = stale.length;

  for (const row of stale) {
    // The reason the screen shows has to match the reason the audit records: a reader
    // who declared "away" gets a different label from one whose browser stopped
    // heartbeating, because the operator acts on them differently — one might come back,
    // the other will not.
    const reason = row.readerState === 'offline' ? 'reader_signed_out'
      : row.readerState === 'away' ? 'reader_went_away'
      : row.lastSeenAt === null ? 'reader_never_heartbeat'
      : 'reader_idle';

    const released = await port.release(row.assignmentId, reason, now);
    if (!released) continue;

    r.released += 1;
    r.byReason[reason] = (r.byReason[reason] ?? 0) + 1;

    await port.audit({
      actorUserId: null,
      tenantId: row.tenantId,
      action: 'dispatch.case_released',
      entityId: String(row.assignmentId),
      detail: {
        studyId: row.studyId,
        clinicianUserId: row.clinicianUserId,
        previousState: row.state,
        reason,
        readerState: row.readerState,
        sinceSeenSeconds: row.sinceSeenSeconds,
      },
    });
  }

  return r;
}
