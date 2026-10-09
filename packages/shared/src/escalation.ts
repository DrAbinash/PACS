import type { Priority } from './enums.js';

// Escalation is the part of an SLA that a contract is actually judged on: not "we have a
// deadline" but "what happened when it started running out". `bootstrap` seeds three
// stages per priority and nothing used to read them, so a late case stayed late in
// silence. This is the rule those stages describe, kept pure and measured in elapsed
// percentage rather than absolute minutes so widening a tenant's contract does not
// require re-editing every timer.

export const ESCALATION_ACTIONS = ['widen_pool', 'alert_ops', 'manual_assign', 'notify_center'] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export const WIDEN_ACTION: EscalationAction = 'widen_pool';

export type EscalationRule = {
  tenantId: number | null;
  priority: Priority;
  stage: number;
  atElapsedPct: number;
  action: EscalationAction;
};

export type ClockLike = {
  id: number;
  studyId: number;
  tenantId: number;
  priority: Priority;
  /** When the measurement began — the study's first-sight time, never "when the poller
   * noticed". */
  startedAt: Date;
  deadlineAt: Date;
  stage: number;
  signedAt: Date | null;
};

export type DueStage = {
  stage: number;
  action: EscalationAction;
  atElapsedPct: number;
  elapsedPct: number;
};

export function elapsedPct(clock: Pick<ClockLike, 'startedAt' | 'deadlineAt'>, now: Date): number {
  const total = clock.deadlineAt.getTime() - clock.startedAt.getTime();
  if (total <= 0) return 100;
  // Deliberately unclamped at the top: a pass must still see 140% and report that the
  // window blew out by two fifths rather than flattening every breach to "100".
  return Math.round(((now.getTime() - clock.startedAt.getTime()) / total) * 100);
}

/**
 * A tenant's own stages replace the platform defaults for that priority rather than
 * merging with them: a center that negotiated a tighter STAT escalation must not also
 * be paged by the generic schedule, and a rule set that quietly unioned would do that.
 */
export function rulesFor(rules: EscalationRule[], tenantId: number, priority: Priority): EscalationRule[] {
  const own = rules.filter((r) => r.tenantId === tenantId && r.priority === priority);
  const usable = own.length > 0
    ? own
    : rules.filter((r) => r.tenantId === null && r.priority === priority);
  return [...usable].sort((a, b) => a.stage - b.stage);
}

/** Stages that have become due and have not been applied yet, lowest stage first. */
export function dueStages(clock: ClockLike, rules: EscalationRule[], now: Date): DueStage[] {
  if (clock.signedAt) return [];
  const pct = elapsedPct(clock, now);
  return rulesFor(rules, clock.tenantId, clock.priority)
    .filter((r) => r.stage > clock.stage && r.atElapsedPct <= pct)
    .map((r) => ({ stage: r.stage, action: r.action, atElapsedPct: r.atElapsedPct, elapsedPct: pct }));
}

export function isBreached(clock: Pick<ClockLike, 'deadlineAt' | 'signedAt'>, now: Date): boolean {
  // A report signed after the deadline still counts as a breach: the contract term is
  // the time to a signed report, not the time to somebody eventually noticing.
  if (clock.signedAt) return clock.signedAt.getTime() > clock.deadlineAt.getTime();
  // The other half of the same sentence: once the answer exists, lateness is frozen at the
  // gap between it and the deadline. Measuring a signed clock against the wall instead
  // would let a deadline moved afterwards — a re-clock after an orphan is linked, a
  // contract renegotiation, a verification script — turn a report that was answered inside
  // its window into a breach on the number a center is billed against.
  return now.getTime() > clock.deadlineAt.getTime();
}

/**
 * The stage at which the pool widens, or null when the tenant never asked for it. The
 * dispatcher reads this so "widen the pool" means one specific thing — an at-capacity
 * reader may be given one more case — and never means sending a spine MRI to a reader
 * whose profile does not cover it. Coverage and a live heartbeat are never widened.
 */
export function widenStage(rules: EscalationRule[], tenantId: number, priority: Priority): number | null {
  const hit = rulesFor(rules, tenantId, priority).find((r) => r.action === WIDEN_ACTION);
  return hit ? hit.stage : null;
}
