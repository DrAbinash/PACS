import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { type Db, criticalEvents, patients, studies, users } from '@telrad/db';
import {
  acknowledgedLate, criticalState, criticalText, minutesToAckDeadline, type CriticalClock,
  type CriticalState,
} from '@telrad/shared';

/**
 * The reads the critical loop needs, in one place because three surfaces ask them: the desk's
 * board, the report panel beside the signature block, and the PDF renderer that has to print
 * what was communicated. A fourth copy of the join is how a document and a screen end up
 * describing the same phone call differently.
 */

export type CriticalRow = {
  id: number;
  studyId: number;
  reportId: number | null;
  tenantId: number;
  conditionCode: string;
  detail: string | null;
  detectedByUserId: number | null;
  detectedByName: string | null;
  detectedAt: Date;
  notifiedAt: Date | null;
  channel: string | null;
  receiverName: string | null;
  receiverRole: string | null;
  receiverPhone: string | null;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
  acknowledgedByUserId: number | null;
  slaMinutes: number;
  breached: boolean;
  accession: string | null;
  patientName: string | null;
  modality: string | null;
};

const columns = {
  id: criticalEvents.id,
  studyId: criticalEvents.studyId,
  reportId: criticalEvents.reportId,
  tenantId: criticalEvents.tenantId,
  conditionCode: criticalEvents.conditionCode,
  detail: criticalEvents.detail,
  detectedByUserId: criticalEvents.detectedByUserId,
  detectedAt: criticalEvents.detectedAt,
  notifiedAt: criticalEvents.notifiedAt,
  channel: criticalEvents.channel,
  receiverName: criticalEvents.receiverName,
  receiverRole: criticalEvents.receiverRole,
  receiverPhone: criticalEvents.receiverPhone,
  acknowledgedAt: criticalEvents.acknowledgedAt,
  acknowledgedByName: criticalEvents.acknowledgedByName,
  acknowledgedByUserId: criticalEvents.acknowledgedByUserId,
  slaMinutes: criticalEvents.slaMinutes,
  breached: criticalEvents.breached,
  detectedByName: users.displayName,
  accession: studies.accessionNumber,
  patientName: patients.fullName,
  modality: studies.modalityCode,
};

const from = (db: Db) => db.select(columns).from(criticalEvents)
  .innerJoin(studies, eq(studies.id, criticalEvents.studyId))
  .leftJoin(patients, eq(patients.id, studies.patientId))
  .leftJoin(users, eq(users.id, criticalEvents.detectedByUserId));

/**
 * Unacknowledged loops for a study, whatever report version they were written into.
 *
 * Counted by study rather than by report on purpose: an amendment produces a new report row,
 * and a finding nobody has answered does not become answered because the document describing
 * it was corrected. The gate follows the patient, not the version number.
 */
export async function openCriticalCount(db: Db, studyId: number): Promise<number> {
  const rows = await db.select({ id: criticalEvents.id }).from(criticalEvents)
    .where(and(eq(criticalEvents.studyId, studyId), isNull(criticalEvents.acknowledgedAt)));
  return rows.length;
}

/**
 * The same count for a page of studies in one query. The delivery board is a list of rows a
 * person reads top to bottom, and a per-row query would make the number of round trips grow
 * with the queue — which is exactly the shape of thing that turns a busy night into a timeout.
 */
export async function openCriticalCounts(db: Db, studyIds: number[]): Promise<Map<number, number>> {
  if (studyIds.length === 0) return new Map();
  const rows = await db.select({
    studyId: criticalEvents.studyId,
    n: count(),
  }).from(criticalEvents)
    .where(and(inArray(criticalEvents.studyId, studyIds), isNull(criticalEvents.acknowledgedAt)))
    .groupBy(criticalEvents.studyId);
  return new Map(rows.map((row) => [row.studyId, row.n]));
}

export async function criticalsForStudy(db: Db, studyId: number): Promise<CriticalRow[]> {
  return await from(db).where(eq(criticalEvents.studyId, studyId)).orderBy(asc(criticalEvents.detectedAt));
}

export async function criticalById(db: Db, id: number): Promise<CriticalRow | null> {
  const [row] = await from(db).where(eq(criticalEvents.id, id)).limit(1);
  return row ?? null;
}

export type OpenCriticalFilter = {
  /** null means the whole platform, which only an operator scope reaches. */
  tenantId: number | null;
  studyId?: number;
  limit: number;
};

export async function openCriticals(db: Db, filter: OpenCriticalFilter): Promise<CriticalRow[]> {
  const rows = await from(db)
    .where(and(
      filter.tenantId === null ? undefined : eq(criticalEvents.tenantId, filter.tenantId),
      filter.studyId === undefined ? undefined : eq(criticalEvents.studyId, filter.studyId),
      isNull(criticalEvents.acknowledgedAt),
    ))
    // Oldest open loop first: this board is worked from the top, and the row that has been
    // waiting longest is the one a reader phoned about hours ago.
    .orderBy(asc(criticalEvents.notifiedAt))
    .limit(filter.limit);
  return rows;
}

export type DescribedCritical = CriticalRow & {
  /** The catalogue label for the code, with the reader's own words after it. */
  text: string;
  /** The instant the acknowledgement fell due. */
  deadlineAt: Date;
  state: CriticalState;
  /** Minutes left, negative once overdue; null when the loop is closed. */
  minutesLeft: number | null;
  /** Acknowledged, but after the deadline — the finding a QC review is about. */
  late: boolean;
  mayAcknowledge: boolean;
};

/**
 * The clock is read from stored columns and never from a caller: a declaration stamps
 * `notifiedAt` server-side, so the fallback to `detectedAt` covers a row with no notification
 * time rather than offering a way to set one from outside.
 */
export function describeCritical(row: CriticalRow, now: Date, mayAcknowledge: boolean): DescribedCritical {
  const clock: CriticalClock = {
    notifiedAt: row.notifiedAt ?? row.detectedAt,
    slaMinutes: row.slaMinutes,
    acknowledgedAt: row.acknowledgedAt,
  };
  const state = criticalState(clock, now);
  return {
    ...row,
    text: criticalText(row.conditionCode, row.detail),
    deadlineAt: new Date(clock.notifiedAt.getTime() + clock.slaMinutes * 60_000),
    state,
    // A closed loop has no countdown, and printing a negative one beside `acknowledged` is
    // how a board ends up looking late after it was answered on time.
    minutesLeft: state === 'acknowledged' ? null : minutesToAckDeadline(clock, now),
    late: acknowledgedLate(clock),
    mayAcknowledge,
  };
}
