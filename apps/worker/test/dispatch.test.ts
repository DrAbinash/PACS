import { describe, expect, it } from 'vitest';
import { dispatchSweep, type DispatchPort, type OfferRecord, type QueueStudy } from '../src/dispatch.js';
import type { EscalationRule, ReaderCandidate } from '@telrad/shared';

// The stages bootstrap ships, so the widening tests exercise the real thresholds.
const WIDEN_FIRST: EscalationRule[] = [
  { tenantId: null, priority: 'stat', stage: 1, atElapsedPct: 55, action: 'widen_pool' },
  { tenantId: null, priority: 'urgent', stage: 1, atElapsedPct: 55, action: 'widen_pool' },
  { tenantId: null, priority: 'routine', stage: 1, atElapsedPct: 55, action: 'widen_pool' },
];

const NOW = new Date('2026-10-09T08:00:00Z');

const study = (over: Partial<QueueStudy> = {}): QueueStudy => ({
  id: 1,
  tenantId: 1,
  orderId: 1,
  priority: 'urgent',
  subSpecialtyCode: 'ct-head',
  modalityCode: 'CT',
  tenantTimezone: 'Asia/Kolkata',
  receivedAt: new Date('2026-10-09T07:50:00Z'),
  escalationStage: 0,
  deadlineAt: new Date('2026-10-09T11:50:00Z'),
  ...over,
});

const reader = (over: Partial<ReaderCandidate> = {}): ReaderCandidate => ({
  userId: 10,
  name: 'Dr Here',
  tenantId: null,
  subspecialtyCodes: ['ct-head'],
  modalityCodes: ['CT'],
  acceptsNight: true,
  maxQueueSize: 5,
  openCases: 0,
  declaredState: 'receiving',
  lastSeenAt: new Date(NOW.getTime() - 5_000),
  lastAssignedAt: null,
  onShift: false,
  ...over,
});

type Offer = { studyId: number; userId: number; attemptNo: number };

// The port is faked rather than the database being started: what is under test is the
// sweep's bookkeeping (load counted as it goes, attempts incremented, a refused insert
// not double-counted), and every one of those is a decision, not a query.
function fakePort(opts: {
  queue?: QueueStudy[];
  panel?: ReaderCandidate[];
  prior?: Map<number, OfferRecord>;
  refuse?: boolean;
  expired?: number;
  rules?: EscalationRule[];
}): { port: DispatchPort; offers: Offer[]; cutoffs: Date[] } {
  const offers: Offer[] = [];
  const cutoffs: Date[] = [];
  return {
    offers,
    cutoffs,
    port: {
      async queue() { return opts.queue ?? []; },
      async panel() { return opts.panel ?? []; },
      async offersByStudy() { return opts.prior ?? new Map(); },
      async offer(studyId, _tenantId, userId, attemptNo) {
        if (opts.refuse) return false;
        offers.push({ studyId, userId, attemptNo });
        return true;
      },
      async expireUnaccepted(cutoff) { cutoffs.push(cutoff); return opts.expired ?? 0; },
      async rules() { return opts.rules ?? []; },
    },
  };
}

describe('dispatchSweep', () => {
  it('offers a queued study to the only eligible reader', async () => {
    const h = fakePort({ queue: [study()], panel: [reader()] });
    const r = await dispatchSweep(h.port, { now: () => NOW });
    expect(r.offered).toBe(1);
    expect(h.offers).toEqual([{ studyId: 1, userId: 10, attemptNo: 1 }]);
  });

  // The panel was read once, before the loop. Without counting locally, a reader with
  // one free slot would be handed every case in the queue in a single tick.
  it('counts the offers it just made against the reader’s own capacity', async () => {
    const h = fakePort({
      queue: [study({ id: 1 }), study({ id: 2 })],
      panel: [reader({ maxQueueSize: 1 })],
    });
    const r = await dispatchSweep(h.port, { now: () => NOW });
    expect(h.offers).toEqual([{ studyId: 1, userId: 10, attemptNo: 1 }]);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0]).toMatchObject({ studyId: 2, reason: 'no_eligible_reader' });
    expect(r.unassigned[0]?.gap?.missing).toContain('queue_full');
  });

  it('spreads a full panel rather than loading one reader first', async () => {
    const h = fakePort({
      queue: [study({ id: 1 }), study({ id: 2 }), study({ id: 3 })],
      panel: [reader({ userId: 11, name: 'A Asha' }), reader({ userId: 12, name: 'B Bala' })],
    });
    await dispatchSweep(h.port, { now: () => NOW });
    expect(h.offers.map((o) => o.userId)).toEqual([11, 12, 11]);
  });

  it('withdraws a stale offer before reading the queue, in the same tick', async () => {
    const h = fakePort({ queue: [], expired: 2 });
    const r = await dispatchSweep(h.port, { now: () => NOW });
    expect(r.expired).toBe(2);
    expect(h.cutoffs[0]?.toISOString()).toBe(new Date(NOW.getTime() - 300_000).toISOString());
  });

  it('rotates to the next reader on a re-offer and increments the attempt', async () => {
    const h = fakePort({
      queue: [study()],
      panel: [reader({ userId: 21, name: 'A First' }), reader({ userId: 22, name: 'B Second' })],
      prior: new Map([[1, { userIds: [21], maxAttempt: 1 }]]),
    });
    await dispatchSweep(h.port, { now: () => NOW });
    expect(h.offers).toEqual([{ studyId: 1, userId: 22, attemptNo: 2 }]);
  });

  it('reports the case as unassigned once everyone eligible has already been asked', async () => {
    const h = fakePort({
      queue: [study()],
      panel: [reader({ userId: 21, name: 'A First' })],
      prior: new Map([[1, { userIds: [21], maxAttempt: 2 }]]),
    });
    const r = await dispatchSweep(h.port, { now: () => NOW });
    expect(r.offered).toBe(0);
    expect(r.unassigned[0]).toMatchObject({ studyId: 1, reason: 'no_eligible_reader' });
    expect(r.unassigned[0]?.gap?.missing).toEqual(['already_offered']);
  });

  it('says no_candidates when there is nobody on the panel', async () => {
    const r = await dispatchSweep(fakePort({ queue: [study()], panel: [] }).port, { now: () => NOW });
    expect(r.unassigned[0]).toMatchObject({ reason: 'no_candidates', gap: null });
  });

  it('does not count an offer the database refused', async () => {
    const h = fakePort({ queue: [study()], panel: [reader()], refuse: true });
    const r = await dispatchSweep(h.port, { now: () => NOW });
    expect(r.offered).toBe(0);
    expect(h.offers).toEqual([]);
  });

  it('asks for no panel at all when the queue is empty', async () => {
    let panelCalls = 0;
    const port: DispatchPort = {
      async queue() { return []; },
      async panel() { panelCalls += 1; return []; },
      async offersByStudy() { return new Map(); },
      async offer() { return true; },
      async expireUnaccepted() { return 0; },
      async rules() { return []; },
    };
    const r = await dispatchSweep(port, { now: () => NOW });
    expect(r).toEqual({ expired: 0, offered: 0, unassigned: [], widened: 0 });
    expect(panelCalls).toBe(0);
  });
});

describe('widening under escalation', () => {
  // The stage on the clock is the only thing that lets a full reader be used, so the
  // sweep has to read it per case rather than globally.
  it('offers a full reader only once the case has reached the widen-pool stage', async () => {
    const full = reader({ userId: 61, name: 'Dr Full', openCases: 2, maxQueueSize: 2 });

    const before = await dispatchSweep(fakePort({ queue: [study()], panel: [full] }).port, { now: () => NOW });
    expect(before.offered).toBe(0);
    expect(before.unassigned[0]?.gap?.missing).toContain('queue_full');

    const after = fakePort({ queue: [study({ escalationStage: 1 })], panel: [full], rules: WIDEN_FIRST });
    const r = await dispatchSweep(after.port, { now: () => NOW });
    expect(r.offered).toBe(1);
    expect(r.widened).toBe(1);
    expect(after.offers.map((o) => o.userId)).toEqual([61]);
  });

  it('does not widen a case whose tenant switched widening off', async () => {
    const full = reader({ userId: 62, name: 'Dr Full', openCases: 2, maxQueueSize: 2 });
    const r = await dispatchSweep(
      fakePort({ queue: [study({ escalationStage: 3 })], panel: [full], rules: [] }).port,
      { now: () => NOW },
    );
    expect(r.offered).toBe(0);
  });
});
