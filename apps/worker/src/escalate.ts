import { dueStages, isBreached, type ClockLike, type EscalationAction, type EscalationRule } from '@telrad/shared';
import type { AuditInput } from '@telrad/db';

export type EscalatableClock = ClockLike & { accessionNumber: string | null };

export type EscalationPort = {
  /** Every clock that has not been delivered yet, oldest deadline first. */
  openClocks(limit: number): Promise<EscalatableClock[]>;
  rules(): Promise<EscalationRule[]>;
  applyStage(clockId: number, stage: number, now: Date): Promise<void>;
  /** False when the row already carries a breach, so the audit line is written once. */
  markBreached(clockId: number, now: Date): Promise<boolean>;
  record(input: AuditInput): Promise<void>;
};

export type EscalateResult = {
  checked: number;
  staged: number;
  breached: number;
  byAction: Partial<Record<EscalationAction, number>>;
};

export function emptyEscalateResult(): EscalateResult {
  return { checked: 0, staged: 0, breached: 0, byAction: {} };
}

// What each stage actually does, stated plainly because two of them cannot do more yet:
//
//   widen_pool     — the dispatcher may offer this case to a reader who is present but
//                    full. Coverage and a live heartbeat are never relaxed.
//   alert_ops      — an audit row and the operator's late board. There is no pager, and
//                    writing "alert_ops" as if there were one would be worse than
//                    admitting the gap.
//   manual_assign  — an audit row and the late board; a person then assigns it by hand
//                    through POST /v1/assignments. Auto-routing keeps trying meanwhile,
//                    because a reader freeing up is good news even at stage three.
//   notify_center  — recorded only. No delivery channel exists.
export async function escalateOnce(
  port: EscalationPort,
  opts: { now?: () => Date; limit?: number } = {},
): Promise<EscalateResult> {
  const now = (opts.now ?? (() => new Date()))();
  const r = emptyEscalateResult();
  const rules = await port.rules();

  for (const clock of await port.openClocks(opts.limit ?? 100)) {
    r.checked += 1;

    for (const due of dueStages(clock, rules, now)) {
      await port.applyStage(clock.id, due.stage, now);
      r.staged += 1;
      r.byAction[due.action] = (r.byAction[due.action] ?? 0) + 1;
      await port.record({
        actorUserId: null,
        actorKind: 'system',
        tenantId: clock.tenantId,
        action: 'sla.escalated',
        entity: 'sla_clocks',
        entityId: String(clock.id),
        detail: {
          studyId: clock.studyId,
          accession: clock.accessionNumber,
          priority: clock.priority,
          stage: due.stage,
          action: due.action,
          atElapsedPct: due.atElapsedPct,
          elapsedPct: due.elapsedPct,
          deadlineAt: clock.deadlineAt,
        },
      });
    }

    if (isBreached(clock, now)) {
      const stamped = await port.markBreached(clock.id, now);
      if (stamped) {
        r.breached += 1;
        await port.record({
          actorUserId: null,
          actorKind: 'system',
          tenantId: clock.tenantId,
          action: 'sla.breached',
          entity: 'sla_clocks',
          entityId: String(clock.id),
          detail: {
            studyId: clock.studyId,
            accession: clock.accessionNumber,
            priority: clock.priority,
            deadlineAt: clock.deadlineAt,
            signedAt: clock.signedAt,
          },
        });
      }
    }
  }

  return r;
}
