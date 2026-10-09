// Routing is the place where the presence board stops being a picture and becomes a
// decision, so the two must not hold two different rules. Everything here is pure and
// takes `now` as an argument: the board calls readerPresence for colour, the dispatcher
// calls pickReader which calls readerPresence, and neither can drift from the other.

import { isNight, type Priority } from './enums.js';
import { readerPresence, type ReaderState } from './presence.js';

// How long an offer stays live before it is withdrawn and rotated to somebody else.
// Five minutes is the number a radiologist can honour by accident (they are reading,
// not refreshing a screen) and still keep a STAT case inside its window.
export const OFFER_ACCEPT_SECONDS = 300;

export const ALL_CODES = '*';

export type DispatchStudy = {
  id: number;
  tenantId: number;
  priority: Priority;
  subSpecialtyCode: string | null;
  modalityCode: string | null;
  // Resolved from the tenant's IANA zone by the caller. The night window is a contract
  // term per tenant, so the dispatcher asks "is it night *there*" rather than assuming
  // the stack's own clock.
  tenantTzOffsetMinutes: number;
};

export type ReaderCandidate = {
  userId: number;
  name: string;
  /** null = a platform reader who may take work from any center. */
  tenantId: number | null;
  subspecialtyCodes: string[];
  modalityCodes: string[];
  acceptsNight: boolean;
  maxQueueSize: number;
  openCases: number;
  declaredState: ReaderState;
  lastSeenAt: Date | null;
  lastAssignedAt: Date | null;
  onShift: boolean;
};

export type RejectReason =
  | 'other_tenant'
  | 'not_routable'
  | 'queue_full'
  | 'no_subspecialty_cover'
  | 'no_modality_cover'
  | 'no_night_cover'
  | 'already_offered';

export type ConsideredReader = {
  userId: number;
  name: string;
  openCases: number;
  maxQueueSize: number;
  /** Present for every reader who was reachable enough to be scored. */
  presenceCode: string | null;
  rejectedFor: RejectReason[];
  /** True when the reader is over their normal capacity and was let in only because the
   * case's clock reached the widen-pool stage. */
  widened: boolean;
};

// A decision cannot be both. Encoding it as a union means a caller that reads
// `chosenUserId` after checking `reason` — or the other way round — gets a compile
// error rather than a null it has to remember to test.
export type RoutingDecision = {
  studyId: number;
  considered: ConsideredReader[];
  /** Eligible readers in the order the rule prefers them. */
  eligible: number[];
} & (
  | { chosenUserId: number; reason: 'assigned' }
  | { chosenUserId: null; reason: 'no_candidates' | 'no_eligible_reader' }
);

export function tzOffsetMinutes(timeZone: string, at: Date): number {
  // Intl gives the wall-clock in a zone; the difference from UTC is the offset. A zone
  // the runtime does not know throws, and this product's tenants are Indian, so IST is
  // the fallback rather than treating a bad string as UTC.
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const hour = get('hour') === 24 ? 0 : get('hour');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return 330;
  }
}

// Empty means no coverage, not unlimited coverage. A profile nobody filled in must not
// end up reading a spine MRI because the code fell through to a permissive default.
export function coversCode(codes: string[], needed: string | null): boolean {
  if (needed === null) return true;
  return codes.includes(ALL_CODES) || codes.includes(needed);
}

export function pickReader(
  study: DispatchStudy,
  candidates: ReaderCandidate[],
  opts: { now: Date; alreadyOfferedTo?: readonly number[]; allowAtCap?: boolean },
): RoutingDecision {
  const offered = new Set(opts.alreadyOfferedTo ?? []);
  const night = isNight(opts.now, study.tenantTzOffsetMinutes);
  const considered: ConsideredReader[] = [];
  const eligible: ReaderCandidate[] = [];

  for (const reader of candidates) {
    const rejectedFor: RejectReason[] = [];
    if (reader.tenantId !== null && reader.tenantId !== study.tenantId) rejectedFor.push('other_tenant');
    if (offered.has(reader.userId)) rejectedFor.push('already_offered');

    // Presence first: it is the fact the board already shows, and colour explains
    // itself better than an invented reason code.
    const presence = readerPresence({
      state: reader.declaredState,
      lastSeenAt: reader.lastSeenAt,
      now: opts.now,
      openCases: reader.openCases,
      maxQueueSize: reader.maxQueueSize,
    });
    // Widening admits a reader who is *present and full*, which is the only amber that
    // means "busy" rather than "unreachable" or "declined". A paused reader stays
    // untouched and a stale tab is still a dead tab.
    const widened = !presence.routable && presence.code === 'at_cap' && opts.allowAtCap === true;
    if (!presence.routable && !widened) {
      rejectedFor.push(presence.code === 'at_cap' ? 'queue_full' : 'not_routable');
    }
    if (!coversCode(reader.subspecialtyCodes, study.subSpecialtyCode)) rejectedFor.push('no_subspecialty_cover');
    if (!coversCode(reader.modalityCodes, study.modalityCode)) rejectedFor.push('no_modality_cover');
    if (night && !reader.acceptsNight) rejectedFor.push('no_night_cover');

    considered.push({
      userId: reader.userId,
      name: reader.name,
      openCases: reader.openCases,
      maxQueueSize: reader.maxQueueSize,
      presenceCode: presence.code,
      rejectedFor,
      widened,
    });
    if (rejectedFor.length === 0) eligible.push(reader);
  }

  considered.sort((a, b) => a.rejectedFor.length - b.rejectedFor.length || a.name.localeCompare(b.name));

  if (eligible.length === 0) {
    return {
      studyId: study.id,
      chosenUserId: null,
      reason: candidates.length === 0 ? 'no_candidates' : 'no_eligible_reader',
      eligible: [],
      considered,
    };
  }

  // Fewest open cases first so one person does not absorb the queue; then whoever is
  // rostered, so night work does not drift to the people who volunteered; then whoever
  // has gone longest without a case, which is what makes rotation visible rather than
  // accidental.
  const ranked = [...eligible].sort((a, b) => a.openCases - b.openCases
    || Number(b.onShift) - Number(a.onShift)
    || (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0)
    || a.name.localeCompare(b.name));

  const chosen = ranked[0]!;
  return {
    studyId: study.id,
    chosenUserId: chosen.userId,
    reason: 'assigned',
    eligible: ranked.map((r) => r.userId),
    considered,
  };
}
