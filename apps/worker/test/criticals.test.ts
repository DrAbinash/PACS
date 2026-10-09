import { describe, expect, it } from 'vitest';
import { criticalSweepOnce, isLateCritical, type CriticalPort, type OpenCriticalEvent } from '../src/criticals.js';

const NOW = new Date('2026-10-10T04:00:00Z');
const NOTIFIED = new Date('2026-10-10T03:00:00Z');
const at = (minutes: number) => new Date(NOTIFIED.getTime() + minutes * 60_000);

const event = (over: Partial<OpenCriticalEvent> = {}): OpenCriticalEvent => ({
  id: 1,
  studyId: 11,
  tenantId: 3,
  conditionCode: 'pneumothorax',
  notifiedAt: NOTIFIED,
  detectedAt: NOTIFIED,
  slaMinutes: 10,
  acknowledgedAt: null,
  accession: 'ACC-1',
  receiverName: 'Dr A. Rao',
  ...over,
});

function fakePort(events: OpenCriticalEvent[]) {
  const stamped: number[] = [];
  const rows: { action: string; detail: Record<string, unknown> }[] = [];
  const port: CriticalPort = {
    // The real query excludes loops answered inside their window, so the sweep never sees them.
    // The fake does the same, which is what makes the "on time" test prove something.
    async eventsToSettle() {
      return events.filter((e) => e.acknowledgedAt === null
        || e.acknowledgedAt.getTime() > (e.notifiedAt ?? e.detectedAt).getTime() + e.slaMinutes * 60_000);
    },
    async markBreached(id) {
      if (stamped.includes(id)) return false;
      stamped.push(id);
      return true;
    },
    async record(input) {
      rows.push({ action: input.action, detail: (input.detail ?? {}) as Record<string, unknown> });
    },
  };
  return { port, stamped, rows };
}

describe('isLateCritical', () => {
  it('calls an open loop late only once its own window has run out', () => {
    expect(isLateCritical(event(), at(9))).toBe(false);
    expect(isLateCritical(event(), at(11))).toBe(true);
    expect(isLateCritical(event({ slaMinutes: 60 }), at(11))).toBe(false);
  });

  it('calls a closed loop late when the answer came after the window', () => {
    expect(isLateCritical(event({ acknowledgedAt: at(45) }), NOW)).toBe(true);
    expect(isLateCritical(event({ acknowledgedAt: at(5) }), NOW)).toBe(false);
  });

  it('measures from the detection when no notification time was recorded', () => {
    expect(isLateCritical(event({ notifiedAt: null }), at(11))).toBe(true);
  });
});

describe('criticalSweepOnce', () => {
  it('stamps an unanswered finding and writes one audit row for it', async () => {
    const { port, stamped, rows } = fakePort([event()]);
    const r = await criticalSweepOnce(port, { now: () => NOW });
    expect(r).toEqual({ checked: 1, breached: 1, waiting: 0 });
    expect(stamped).toEqual([1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('critical.breached');
    expect(rows[0]!.detail).toMatchObject({
      studyId: 11,
      accession: 'ACC-1',
      conditionCode: 'pneumothorax',
      receiverName: 'Dr A. Rao',
      slaMinutes: 10,
      // Fifty minutes past: 04:00 against a deadline of 03:10, measured from the notification
      // rather than from the signature.
      minutesPastDeadline: 50,
      acknowledgedAt: null,
    });
  });

  it('leaves a loop still inside its window alone, and says it is waiting', async () => {
    const soon = new Date(NOTIFIED.getTime() + 4 * 60_000);
    const { port, stamped, rows } = fakePort([event()]);
    const r = await criticalSweepOnce(port, { now: () => soon });
    expect(r).toEqual({ checked: 1, breached: 0, waiting: 1 });
    expect(stamped).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('stamps a finding that was acknowledged late, because the patient waited anyway', async () => {
    // The row is closed by the time the sweep runs. Reading only open loops would let a breach
    // be erased by the very acknowledgement that arrived too late to prevent it.
    const { port, stamped, rows } = fakePort([event({ acknowledgedAt: at(45) })]);
    const r = await criticalSweepOnce(port, { now: () => NOW });
    expect(r.breached).toBe(1);
    expect(stamped).toEqual([1]);
    expect(rows[0]!.detail.acknowledgedAt).toEqual(at(45));
  });

  it('does not stamp a loop that was answered inside its window', async () => {
    const { port, stamped, rows } = fakePort([event({ acknowledgedAt: at(6) })]);
    const r = await criticalSweepOnce(port, { now: () => NOW });
    expect(r).toEqual({ checked: 0, breached: 0, waiting: 0 });
    expect(stamped).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('writes one breach row when two sweeps race the same finding', async () => {
    // The guarded update returns false for whoever loses, and a sweep that stamps nothing must
    // not write the audit line either — otherwise one missed phone call is two breaches.
    const rows: unknown[] = [];
    const port: CriticalPort = {
      async eventsToSettle() { return [event()]; },
      async markBreached() { return false; },
      async record(input) { rows.push(input); },
    };
    const r = await criticalSweepOnce(port, { now: () => NOW });
    expect(r).toEqual({ checked: 1, breached: 0, waiting: 0 });
    expect(rows).toHaveLength(0);
  });

  it('settles each finding on its own deadline, not on a single global window', async () => {
    const { port, rows } = fakePort([
      event({ id: 1, conditionCode: 'suspected-malignancy', slaMinutes: 1440, notifiedAt: at(-60) }),
      event({ id: 2, conditionCode: 'pneumothorax', slaMinutes: 10, notifiedAt: at(-60) }),
    ]);
    // Now is 04:00 and both were notified at 02:00. The ten-minute one is two hours overdue;
    // the day-long one is nowhere near its own deadline and must not be swept up with it.
    const r = await criticalSweepOnce(port, { now: () => NOW });
    expect(r).toMatchObject({ checked: 2, breached: 1, waiting: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.conditionCode).toBe('pneumothorax');
  });
});
