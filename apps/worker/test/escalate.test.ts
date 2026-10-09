import { describe, expect, it } from 'vitest';
import { escalateOnce, type EscalatableClock, type EscalationPort } from '../src/escalate.js';
import type { EscalationRule } from '@telrad/shared';

const NOW = new Date('2026-10-09T02:30:00Z');

const clock = (over: Partial<EscalatableClock> = {}): EscalatableClock => ({
  id: 1,
  studyId: 11,
  tenantId: 1,
  priority: 'urgent',
  startedAt: new Date('2026-10-09T00:00:00Z'),
  deadlineAt: new Date('2026-10-09T04:00:00Z'),
  stage: 0,
  signedAt: null,
  accessionNumber: 'ACC-1',
  ...over,
});

const RULES: EscalationRule[] = [
  { tenantId: null, priority: 'urgent', stage: 1, atElapsedPct: 55, action: 'widen_pool' },
  { tenantId: null, priority: 'urgent', stage: 2, atElapsedPct: 75, action: 'alert_ops' },
  { tenantId: null, priority: 'urgent', stage: 3, atElapsedPct: 92, action: 'manual_assign' },
];

function fakeClocks(clocks: EscalatableClock[], rules = RULES) {
  const seen: { clockId: number; stage: number }[] = [];
  const actions: { action: string; detail: Record<string, unknown> }[] = [];
  const port: EscalationPort = {
    async openClocks() { return clocks; },
    async rules() { return rules; },
    async applyStage(clockId, stage) { seen.push({ clockId, stage }); },
    async markBreached(clockId) {
      // Mirrors the guarded update: the second pass finds nothing left to stamp.
      if (seen.some((s) => s.clockId === clockId && s.stage === -1)) return false;
      seen.push({ clockId, stage: -1 });
      return true;
    },
    async record(input) { actions.push({ action: input.action, detail: (input.detail ?? {}) as Record<string, unknown> }); },
  };
  return { port, seen, actions };
}

describe('escalateOnce', () => {
  it('does nothing while a case is inside its window', async () => {
    const young = clock({ startedAt: new Date('2026-10-09T02:00:00Z'), deadlineAt: new Date('2026-10-09T06:00:00Z') });
    const h = fakeClocks([young]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, staged: 0, breached: 0 });
    expect(h.actions).toEqual([]);
  });

  it('fires the due stage, stamps it on the clock and writes one audit line', async () => {
    // 150 of 225 minutes gone: past 55 %, short of 75 %, so exactly one stage is due.
    const late = clock({ deadlineAt: new Date('2026-10-09T03:45:00Z') });
    const h = fakeClocks([late]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(1);
    expect(r.byAction.widen_pool).toBe(1);
    expect(h.seen).toEqual([{ clockId: 1, stage: 1 }]);
    expect(h.actions[0]?.action).toBe('sla.escalated');
    expect(h.actions[0]?.detail).toMatchObject({ studyId: 11, accession: 'ACC-1', stage: 1, action: 'widen_pool' });
  });

  it('catches up every stage it missed rather than one per pass', async () => {
    const veryLate = clock({ deadlineAt: new Date('2026-10-09T02:35:00Z') });
    const h = fakeClocks([veryLate]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(3);
    expect(h.seen.filter((s) => s.stage > 0).map((s) => s.stage)).toEqual([1, 2, 3]);
  });

  it('never re-fires a stage the clock already carries', async () => {
    const h = fakeClocks([clock({ stage: 2, deadlineAt: new Date('2026-10-09T02:35:00Z') })]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(1);
    expect(h.seen).toEqual([{ clockId: 1, stage: 3 }]);
  });

  it('leaves a signed case alone but still records the breach', async () => {
    const signedLate = clock({ signedAt: new Date('2026-10-09T04:30:00Z'), deadlineAt: new Date('2026-10-09T02:00:00Z') });
    const h = fakeClocks([signedLate]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(0);
    expect(r.breached).toBe(1);
    expect(h.actions[0]?.action).toBe('sla.breached');
    expect(h.actions[0]?.detail).toMatchObject({ signedAt: new Date('2026-10-09T04:30:00Z') });
  });

  // Lateness is frozen at the signature. A clock whose deadline is rewritten afterwards —
  // a re-clock, a contract change, this repository's own verification script — must not
  // give a reader a breach they never caused.
  it('does not stamp a breach on a case signed inside its window', async () => {
    const signedOnTime = clock({
      signedAt: new Date('2026-10-09T01:30:00Z'),
      deadlineAt: new Date('2026-10-09T02:00:00Z'),
    });
    const h = fakeClocks([signedOnTime]);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(0);
    expect(r.breached).toBe(0);
    expect(h.actions).toEqual([]);
  });

  it('records a breach once, not on every pass', async () => {
    const breached = clock({ deadlineAt: new Date('2026-10-09T01:00:00Z') });
    const h = fakeClocks([breached]);
    await escalateOnce(h.port, { now: () => NOW });
    const second = await escalateOnce(h.port, { now: () => NOW });
    expect(second.breached).toBe(0);
  });

  it('does nothing at all when the deployment configured no rules', async () => {
    const h = fakeClocks([clock({ deadlineAt: new Date('2026-10-09T02:00:00Z') })], []);
    const r = await escalateOnce(h.port, { now: () => NOW });
    expect(r.staged).toBe(0);
    expect(r.breached).toBe(1);
  });

  it('checks nothing when there are no open clocks', async () => {
    const h = fakeClocks([]);
    expect(await escalateOnce(h.port, { now: () => NOW })).toMatchObject({ checked: 0 });
  });
});
