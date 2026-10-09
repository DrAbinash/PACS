import { acknowledgedLate, criticalState, type CriticalClock } from '@telrad/shared';
import type { AuditInput } from '@telrad/db';

/**
 * The half of the critical loop that runs on nobody's click.
 *
 * A report SLA measures how fast the service answers. This measures how fast a named human at
 * the referring end said they had heard a life-threatening result, and the two are not the same
 * number: a report signed inside forty minutes and acknowledged eleven hours later is a bad
 * night, and nothing else in the system would say so.
 */

export type OpenCriticalEvent = {
  id: number;
  studyId: number;
  tenantId: number;
  conditionCode: string;
  notifiedAt: Date | null;
  detectedAt: Date;
  slaMinutes: number;
  acknowledgedAt: Date | null;
  accession: string | null;
  receiverName: string | null;
};

export type CriticalPort = {
  /**
   * Every loop that can still become or still be a breach: open ones, and closed ones whose
   * acknowledgement arrived after their own deadline. A loop answered in time is excluded by the
   * query rather than re-examined here, so the set the sweep walks does not grow with history.
   */
  eventsToSettle(limit: number): Promise<OpenCriticalEvent[]>;
  /**
   * Settle the row. There is no timestamp column for it: the moment the breach was noticed is
   * in the audit row the sweep writes beside it, and the row itself only carries the finding.
   * False when another process settled this one first, so the audit line is written once.
   */
  markBreached(id: number): Promise<boolean>;
  record(input: AuditInput): Promise<void>;
};

export type CriticalSweepResult = { checked: number; breached: number; waiting: number };

export function emptyCriticalSweepResult(): CriticalSweepResult {
  return { checked: 0, breached: 0, waiting: 0 };
}

const clockOf = (event: OpenCriticalEvent): CriticalClock => ({
  notifiedAt: event.notifiedAt ?? event.detectedAt,
  slaMinutes: event.slaMinutes,
  acknowledgedAt: event.acknowledgedAt,
});

export function criticalDeadlineOf(event: OpenCriticalEvent): Date {
  return new Date(clockOf(event).notifiedAt.getTime() + event.slaMinutes * 60_000);
}

/**
 * Late, or still waiting past the deadline.
 *
 * An acknowledgement that arrived after the deadline counts even though the loop is closed by
 * then: without that, a sweep that had not yet run when the call finally came in would settle
 * the row as clean, and the breach would depend on when a process woke up rather than on what
 * happened to the patient.
 */
export function isLateCritical(event: OpenCriticalEvent, now: Date): boolean {
  const clock = clockOf(event);
  return event.acknowledgedAt !== null
    ? acknowledgedLate(clock)
    : criticalState(clock, now) === 'breached';
}

export async function criticalSweepOnce(
  port: CriticalPort,
  opts: { now?: () => Date; limit?: number } = {},
): Promise<CriticalSweepResult> {
  const now = (opts.now ?? (() => new Date()))();
  const r = emptyCriticalSweepResult();

  for (const event of await port.eventsToSettle(opts.limit ?? 200)) {
    r.checked += 1;
    const deadlineAt = criticalDeadlineOf(event);

    if (!isLateCritical(event, now)) {
      // An open loop still inside its window. Counted so a tick that is doing nothing but
      // watching is distinguishable from a tick that found nothing at all.
      r.waiting += 1;
      continue;
    }

    const stamped = await port.markBreached(event.id);
    if (!stamped) continue;
    r.breached += 1;
    await port.record({
      actorUserId: null,
      actorKind: 'system',
      tenantId: event.tenantId,
      action: 'critical.breached',
      entity: 'critical_events',
      entityId: String(event.id),
      detail: {
        studyId: event.studyId,
        accession: event.accession,
        conditionCode: event.conditionCode,
        receiverName: event.receiverName,
        slaMinutes: event.slaMinutes,
        deadlineAt,
        // How far past, in the same unit the promise was written in. For an acknowledged row
        // this is the delay the acknowledgement has already ended; for an open one it is how
        // long the finding has been sitting unanswered.
        minutesPastDeadline: Math.round((now.getTime() - deadlineAt.getTime()) / 60_000),
        acknowledgedAt: event.acknowledgedAt,
      },
    });
  }

  return r;
}
