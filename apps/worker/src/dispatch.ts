import { OFFER_ACCEPT_SECONDS, pickReader, tzOffsetMinutes, type DispatchStudy, type Priority, type ReaderCandidate } from '@telrad/shared';

export type QueueStudy = {
  id: number;
  tenantId: number;
  orderId: number;
  priority: Priority;
  subSpecialtyCode: string | null;
  modalityCode: string | null;
  tenantTimezone: string;
  receivedAt: Date;
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
};

export function emptyDispatchResult(): DispatchResult {
  return { expired: 0, offered: 0, unassigned: [] };
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
    const decision = pickReader(study, candidates, { now, alreadyOfferedTo: record?.userIds ?? [] });

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
      handedOut.set(decision.chosenUserId, (handedOut.get(decision.chosenUserId) ?? 0) + 1);
    }
  }

  return r;
}
