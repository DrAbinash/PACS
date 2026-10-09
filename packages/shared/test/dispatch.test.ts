import { describe, expect, it } from 'vitest';
import { OFFER_ACCEPT_SECONDS, pickReader, tzOffsetMinutes, type DispatchStudy, type ReaderCandidate } from '../src/dispatch.js';

const DAY = new Date('2026-10-09T08:00:00Z');      // 13:30 IST
const NIGHT = new Date('2026-10-09T20:00:00Z');     // 01:30 IST next day
const seen = (agoSeconds: number, now = DAY) => new Date(now.getTime() - agoSeconds * 1000);

const study = (over: Partial<DispatchStudy> = {}): DispatchStudy => ({
  id: 1,
  tenantId: 1,
  priority: 'urgent',
  subSpecialtyCode: 'ct-head',
  modalityCode: 'CT',
  tenantTzOffsetMinutes: 330,
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
  lastSeenAt: seen(5),
  lastAssignedAt: null,
  onShift: false,
  ...over,
});

const reasons = (d: ReturnType<typeof pickReader>, userId: number) =>
  d.considered.find((c) => c.userId === userId)?.rejectedFor ?? ['absent'];

describe('pickReader', () => {
  it('gives the case to a green reader who covers it', () => {
    const d = pickReader(study(), [reader()], { now: DAY });
    expect(d).toMatchObject({ chosenUserId: 10, reason: 'assigned', eligible: [10] });
  });

  // The point of the board and the point of the router being one function: a paused
  // reader looks amber to the operator and is not offered work by the dispatcher.
  it('skips a reader who paused, with the reason a human would use', () => {
    const d = pickReader(study(), [reader({ declaredState: 'paused' })], { now: DAY });
    expect(d.chosenUserId).toBeNull();
    expect(d.reason).toBe('no_eligible_reader');
    expect(reasons(d, 10)).toContain('not_routable');
  });

  it('skips a reader whose tab died, whatever their declared state says', () => {
    const d = pickReader(study(), [reader({ lastSeenAt: seen(60 * 60 * 9) })], { now: DAY });
    expect(d.chosenUserId).toBeNull();
    expect(d.considered[0]?.presenceCode).toBe('idle');
    expect(reasons(d, 10)).toContain('not_routable');
  });

  it('names a full queue as its own reason rather than blending it into absence', () => {
    const d = pickReader(study(), [reader({ openCases: 5, maxQueueSize: 5 })], { now: DAY });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 10)).toContain('queue_full');
    expect(d.considered[0]?.presenceCode).toBe('at_cap');
  });

  it('will not route a head CT to a reader whose profile does not list it', () => {
    const d = pickReader(study({ subSpecialtyCode: 'mr-spine', modalityCode: 'MR' }),
      [reader()], { now: DAY });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 10)).toEqual(['no_subspecialty_cover', 'no_modality_cover']);
  });

  it('treats an empty profile as no coverage, not as unlimited coverage', () => {
    const d = pickReader(study(), [reader({ subspecialtyCodes: [], modalityCodes: [] })], { now: DAY });
    expect(d.chosenUserId).toBeNull();
  });

  it('takes a wildcard profile as a deliberate cover-everything', () => {
    const d = pickReader(study({ subSpecialtyCode: 'us-abdomen', modalityCode: 'US' }),
      [reader({ subspecialtyCodes: ['*'], modalityCodes: ['*'] })], { now: DAY });
    expect(d.chosenUserId).toBe(10);
  });

  it('keeps a center-owned reader out of another center’s queue', () => {
    const d = pickReader(study({ tenantId: 1 }), [reader({ tenantId: 2 })], { now: DAY });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 10)).toContain('other_tenant');
  });

  it('lets a platform reader with no tenant serve any center', () => {
    expect(pickReader(study({ tenantId: 7 }), [reader({ tenantId: null })], { now: DAY }).chosenUserId).toBe(10);
  });

  it('does not offer a 01:30 case to a reader who does not take nights', () => {
    const d = pickReader(study(), [reader({ acceptsNight: false })], { now: NIGHT });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 10)).toContain('no_night_cover');
    // Same reader, afternoon: the night flag is not a general exclusion.
    expect(pickReader(study(), [reader({ acceptsNight: false })], { now: DAY }).chosenUserId).toBe(10);
  });

  it('gives the case to the least-loaded reader rather than the first one listed', () => {
    const d = pickReader(study(), [
      reader({ userId: 11, name: 'Dr Busy', openCases: 3 }),
      reader({ userId: 12, name: 'Dr Free', openCases: 0 }),
    ], { now: DAY });
    expect(d.chosenUserId).toBe(12);
    expect(d.eligible).toEqual([12, 11]);
  });

  it('breaks a load tie toward the rostered reader, then toward whoever waited longest', () => {
    const d = pickReader(study(), [
      reader({ userId: 21, name: 'A Ayaan', onShift: false, lastAssignedAt: new Date('2026-10-09T07:00:00Z') }),
      reader({ userId: 22, name: 'B Bela', onShift: true, lastAssignedAt: new Date('2026-10-09T07:30:00Z') }),
    ], { now: DAY });
    expect(d.chosenUserId).toBe(22);

    const idle = pickReader(study(), [
      reader({ userId: 23, name: 'C Chirag', lastAssignedAt: new Date('2026-10-09T07:59:00Z') }),
      reader({ userId: 24, name: 'D Diya', lastAssignedAt: new Date('2026-10-09T06:00:00Z') }),
    ], { now: DAY });
    expect(idle.chosenUserId).toBe(24);
  });

  it('puts a reader who has never had a case before a reader who just had one', () => {
    const d = pickReader(study(), [
      reader({ userId: 25, name: 'A Ever', lastAssignedAt: new Date('2026-10-09T05:00:00Z') }),
      reader({ userId: 26, name: 'B New', lastAssignedAt: null }),
    ], { now: DAY });
    expect(d.chosenUserId).toBe(26);
  });

  it('rotates past readers who were already offered this case', () => {
    const all = [reader({ userId: 31, name: 'A One' }), reader({ userId: 32, name: 'B Two' })];
    expect(pickReader(study(), all, { now: DAY }).chosenUserId).toBe(31);
    const second = pickReader(study(), all, { now: DAY, alreadyOfferedTo: [31] });
    expect(second.chosenUserId).toBe(32);
    expect(reasons(second, 31)).toContain('already_offered');
  });

  it('says no_candidates when nobody is on the panel at all', () => {
    expect(pickReader(study(), [], { now: DAY }).reason).toBe('no_candidates');
  });

  it('lists the reasons for every reachable reader when none qualifies', () => {
    const d = pickReader(study(), [
      reader({ userId: 41, name: 'Dr Paused', declaredState: 'paused' }),
      reader({ userId: 42, name: 'Dr Chest-only', subspecialtyCodes: ['dr-chest'], modalityCodes: ['DX'] }),
      reader({ userId: 43, name: 'Dr Full', openCases: 5 }),
    ], { now: DAY });
    expect(d.reason).toBe('no_eligible_reader');
    expect(d.considered.map((c) => c.userId).sort()).toEqual([41, 42, 43]);
    // Sorted fewest-rejections-first, so an operator reading the gap sees the closest
    // miss at the top.
    expect(d.considered[0]?.rejectedFor).toHaveLength(1);
  });

  it('orders the queue decision by nothing but the rule: a STAT study uses the same function', () => {
    const d = pickReader(study({ priority: 'stat' }), [reader()], { now: DAY });
    expect(d.chosenUserId).toBe(10);
  });

  it('publishes the accept window the sweep and the console both use', () => {
    expect(OFFER_ACCEPT_SECONDS).toBe(300);
  });
});

// Widening is the one thing an escalation stage is allowed to do to the routing rule, so
// its edges are the ones that matter: it must reach a reader who is busy, and never one
// who is absent, declined, or clinically out of scope.
describe('pickReader under widen_pool', () => {
  const full = reader({ userId: 51, name: 'Dr Full', openCases: 2, maxQueueSize: 2 });

  it('gives the case to a full reader once the pool widens', () => {
    const d = pickReader(study(), [full], { now: DAY, allowAtCap: true });
    expect(d.chosenUserId).toBe(51);
    expect(d.considered[0]).toMatchObject({ widened: true, rejectedFor: [], presenceCode: 'at_cap' });
  });

  it('still refuses a reader who paused, because that is a person saying no', () => {
    const d = pickReader(study(), [reader({ userId: 52, declaredState: 'paused' })], { now: DAY, allowAtCap: true });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 52)).toContain('not_routable');
  });

  it('still refuses a reader whose tab died, because widening cannot make them present', () => {
    const d = pickReader(study(), [reader({ userId: 53, lastSeenAt: seen(60 * 60 * 4) })], { now: DAY, allowAtCap: true });
    expect(d.chosenUserId).toBeNull();
  });

  it('still refuses a full reader who does not cover the case, because coverage is not a capacity question', () => {
    const d = pickReader(study({ subSpecialtyCode: 'mr-spine', modalityCode: 'MR' }),
      [reader({ userId: 54, openCases: 2, maxQueueSize: 2 })], { now: DAY, allowAtCap: true });
    expect(d.chosenUserId).toBeNull();
    expect(reasons(d, 54)).toContain('no_subspecialty_cover');
  });

  it('prefers a reader with a free slot over a widened one', () => {
    const d = pickReader(study(), [
      full,
      reader({ userId: 55, name: 'Zoe Free', openCases: 0, maxQueueSize: 2 }),
    ], { now: DAY, allowAtCap: true });
    expect(d.chosenUserId).toBe(55);
    expect(d.eligible).toEqual([55, 51]);
  });
});

describe('tzOffsetMinutes', () => {
  it('is east-positive for India, which is what isNight expects', () => {
    expect(tzOffsetMinutes('Asia/Kolkata', DAY)).toBe(330);
  });

  it('follows a zone across its own daylight saving edge', () => {
    expect(tzOffsetMinutes('Europe/London', new Date('2026-01-15T12:00:00Z'))).toBe(0);
    expect(tzOffsetMinutes('Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe(60);
  });

  it('falls back to IST rather than treating an unparseable zone as UTC', () => {
    expect(tzOffsetMinutes('Mars/Phobos', DAY)).toBe(330);
  });
});
