import {
  OFFER_ACCEPT_SECONDS, pickReader, tzOffsetMinutes, widenStage,
  type DispatchStudy, type EscalationRule, type Priority, type ReaderCandidate,
} from '@telrad/shared';

export type QueueStudy = {
  id: number;
  tenantId: number;
  orderId: number;
  priority: Priority;
  subSpecialtyCode: string | null;
  modalityCode: string | null;
  tenantTimezone: string;
  receivedAt: Date;
  escalationStage: number;
  deadlineAt: Date | null;
};

export type OfferRecord = { userIds: number[]; maxAttempt: number };

export type DispatchPort = {
  /** Linked, complete studies with no live lock, STAT first. */
  queue(limit: number): Promise<QueueStudy[]>;
  /** Every reader who could serve any of these tenants, with load and last work. */
  panel(tenantIds: number[], now: Date): Promise<ReaderCandidate[]>;
  offersByStudy(studyIds: number[]): Promise<Map<number, OfferRecord>>;
  /** False when the live-lock index refused, which means another worker got there first. */
  offer(studyId: number, tenantId: number, userId: number, attemptNo: number, now: Date): Promise<boolean>;
  expireUnaccepted(cutoff: Date): Promise<number>;
  /** The escalation stages this deployment configured, so the sweep knows whether the
   * pool has been widened for a case that is running out of time. */
  rules(): Promise<EscalationRule[]>;
};

export type UnassignedStudy = {
  studyId: number;
  reason: 'no_candidates' | 'no_eligible_reader';
  /** The closest miss and what it was missing, which is what an operator acts on. */
  gap: { userId: number; name: string; missing: string[] } | null;
};

export type DispatchResult = {
  expired: number;
  offered: number;
  unassigned: UnassignedStudy[];
  /** Offers made to a reader who was already at capacity, because their case had reached
   * the widen-pool stage. Named separately because it is the one routing decision an
   * operator would want to see without asking. */
  widened: number;
};

export function emptyDispatchResult(): DispatchResult {
  return { expired: 0, offered: 0, unassigned: [], widened: 0 };
}

// One sweep: withdraw what nobody took, then work the queue top-down. Expire runs
// first so a case whose offer lapsed can go to the next reader in the same tick
// rather than waiting ten seconds for the following one.
export async function dispatchSweep(
  port: DispatchPort,
  opts: { now?: () => Date; limit?: number } = {},
): Promise<DispatchResult> {
  const now = (opts.now ?? (() => new Date()))();
  const r = emptyDispatchResult();

  r.expired = await port.expireUnaccepted(new Date(now.getTime() - OFFER_ACCEPT_SECONDS * 1000));

  const queue = await port.queue(opts.limit ?? 25);
  if (queue.length === 0) return r;

  const tenants = [...new Set(queue.map((s) => s.tenantId))];
  const panel = await port.panel(tenants, now);
  const prior = await port.offersByStudy(queue.map((s) => s.id));
  const rules = await port.rules();

  // Load is counted locally as offers go out. The panel read is a snapshot from the
  // start of the sweep, so without this a single green reader with three free slots
  // would be handed every case in the queue while an equally idle colleague saw none.
  const handedOut = new Map<number, number>();
  for (const row of queue) {
    const study: DispatchStudy = {
      id: row.id,
      tenantId: row.tenantId,
      priority: row.priority,
      subSpecialtyCode: row.subSpecialtyCode,
      modalityCode: row.modalityCode,
      tenantTzOffsetMinutes: tzOffsetMinutes(row.tenantTimezone, now),
    };
    const candidates = panel.map((reader) => {
      const extra = handedOut.get(reader.userId) ?? 0;
      return extra === 0 ? reader : { ...reader, openCases: reader.openCases + extra };
    });

    const record = prior.get(row.id);
    // Widening is per case, read off its own clock stage: a routine study at 20 % of its
    // window does not get pushed onto a full reader just because a STAT elsewhere did.
    const widenAt = widenStage(rules, row.tenantId, row.priority);
    const allowAtCap = widenAt !== null && row.escalationStage >= widenAt;
    const decision = pickReader(study, candidates, {
      now, alreadyOfferedTo: record?.userIds ?? [], allowAtCap,
    });

    if (decision.chosenUserId === null) {
      const closest = decision.considered[0];
      r.unassigned.push({
        studyId: row.id,
        reason: decision.reason,
        gap: closest
          ? { userId: closest.userId, name: closest.name, missing: closest.rejectedFor }
          : null,
      });
      continue;
    }

    const created = await port.offer(row.id, row.tenantId, decision.chosenUserId,
      (record?.maxAttempt ?? 0) + 1, now);
    if (created) {
      r.offered += 1;
      if (allowAtCap && decision.considered.find((c) => c.userId === decision.chosenUserId)?.widened) r.widened += 1;
      handedOut.set(decision.chosenUserId, (handedOut.get(decision.chosenUserId) ?? 0) + 1);
    }
  }

  return r;
}
