import { describe, expect, it } from 'vitest';
import { dueStages, elapsedPct, isBreached, rulesFor, widenStage, type ClockLike, type EscalationRule } from '../src/escalation.js';

const START = new Date('2026-10-09T00:00:00Z');
const DEADLINE = new Date('2026-10-09T04:00:00Z');      // a 240-minute window
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

const clock = (over: Partial<ClockLike> = {}): ClockLike => ({
  id: 1,
  studyId: 11,
  tenantId: 1,
  priority: 'urgent',
  startedAt: START,
  deadlineAt: DEADLINE,
  stage: 0,
  signedAt: null,
  ...over,
});

// Exactly what `bootstrap` seeds, so the thresholds under test are the shipped ones.
const DEFAULTS: EscalationRule[] = (['stat', 'urgent', 'routine'] as const).flatMap((priority) => [
  { tenantId: null, priority, stage: 1, atElapsedPct: 55, action: 'widen_pool' as const },
  { tenantId: null, priority, stage: 2, atElapsedPct: 75, action: 'alert_ops' as const },
  { tenantId: null, priority, stage: 3, atElapsedPct: 92, action: 'manual_assign' as const },
]);

describe('elapsedPct', () => {
  it('measures the contract window, not the clock on the wall', () => {
    expect(elapsedPct(clock(), at(0))).toBe(0);
    expect(elapsedPct(clock(), at(120))).toBe(50);
    expect(elapsedPct(clock(), at(240))).toBe(100);
  });

  // Flattening this to 100 would hide how badly a case blew out, which is the number a
  // center asks about.
  it('reports past-due as more than 100 rather than clamping it', () => {
    expect(elapsedPct(clock(), at(336))).toBe(140);
  });

  it('treats a zero-length window as fully elapsed instead of dividing by it', () => {
    expect(elapsedPct(clock({ deadlineAt: START }), at(0))).toBe(100);
  });
});

describe('rulesFor', () => {
  it('uses the platform stages when a tenant has negotiated none', () => {
    expect(rulesFor(DEFAULTS, 7, 'urgent').map((r) => r.stage)).toEqual([1, 2, 3]);
  });

  it('replaces rather than merges: a tighter tenant schedule does not also run the default one', () => {
    const tenant: EscalationRule[] = [
      ...DEFAULTS,
      { tenantId: 1, priority: 'urgent', stage: 1, atElapsedPct: 30, action: 'alert_ops' },
    ];
    const forTenant = rulesFor(tenant, 1, 'urgent');
    expect(forTenant).toHaveLength(1);
    expect(forTenant[0]).toMatchObject({ atElapsedPct: 30, action: 'alert_ops' });
    // Other tenants keep the defaults.
    expect(rulesFor(tenant, 2, 'urgent')).toHaveLength(3);
  });

  it('orders stages by stage number whatever order the rows arrive in', () => {
    const shuffled = [...DEFAULTS].reverse();
    expect(rulesFor(shuffled, 1, 'routine').map((r) => r.atElapsedPct)).toEqual([55, 75, 92]);
  });
});

describe('dueStages', () => {
  it('fires nothing while the window is young', () => {
    expect(dueStages(clock(), DEFAULTS, at(30))).toEqual([]);
  });

  it('fires stage 1 at 55 percent and takes the 30-minute head CT off the stretcher', () => {
    const due = dueStages(clock(), DEFAULTS, at(132));
    expect(due).toEqual([{ stage: 1, action: 'widen_pool', atElapsedPct: 55, elapsedPct: 55 }]);
  });

  it('catches up through several stages at once after a worker outage', () => {
    // The stage column is the only memory, so a pass that did not run for hours must
    // apply every stage it missed rather than only the next one.
    const due = dueStages(clock(), DEFAULTS, at(230));
    expect(due.map((d) => [d.stage, d.action])).toEqual([[1, 'widen_pool'], [2, 'alert_ops'], [3, 'manual_assign']]);
  });

  it('never re-applies a stage the clock already carries', () => {
    expect(dueStages(clock({ stage: 2 }), DEFAULTS, at(230))).toHaveLength(1);
  });

  it('stops escalating the moment a report is signed', () => {
    expect(dueStages(clock({ signedAt: at(200) }), DEFAULTS, at(230))).toEqual([]);
  });

  it('gives up quietly when a tenant switched every stage off', () => {
    expect(dueStages(clock(), [], at(230))).toEqual([]);
  });
});

describe('isBreached', () => {
  it('breaches at the deadline, not a minute before', () => {
    expect(isBreached(clock(), at(239))).toBe(false);
    expect(isBreached(clock(), at(240))).toBe(false);
    expect(isBreached(clock(), at(241))).toBe(true);
  });

  // The contract term is a signed report by the deadline, so a late signature is a
  // breach even though the case is now closed.
  it('counts a report signed after the deadline as breached', () => {
    expect(isBreached(clock({ signedAt: at(300) }), at(301))).toBe(true);
  });

  // And the converse, which is what a deadline moved after the fact depends on: an answer
  // that landed inside its window cannot be made late by rewriting the clock underneath it.
  it('freezes lateness at the signature, so a signed-on-time clock never becomes a breach', () => {
    expect(isBreached(clock({ signedAt: at(150) }), at(1000))).toBe(false);
    expect(isBreached(clock({ signedAt: at(240) }), at(1000))).toBe(false);
  });

  it('keeps an unsigned clock measured against the time it is now', () => {
    expect(isBreached(clock({ signedAt: null }), at(1_000))).toBe(true);
  });
});

describe('widenStage', () => {
  it('finds the stage the dispatcher should relax capacity at', () => {
    expect(widenStage(DEFAULTS, 1, 'stat')).toBe(1);
  });

  it('returns null for a tenant that never asked to widen, so nothing widens', () => {
    const noWiden: EscalationRule[] = [
      { tenantId: 4, priority: 'urgent', stage: 1, atElapsedPct: 60, action: 'alert_ops' },
    ];
    expect(widenStage(noWiden, 4, 'urgent')).toBeNull();
  });
});
