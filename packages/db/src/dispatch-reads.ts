import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import {
  assignments, clinicianProfiles, readerAvailability, rosters, studies, tenants, users,
} from './schema.js';

// Both the dispatcher's sweep and the console's "why is this nobody's case" read need
// the same two questions answered. They live here so the answer cannot drift: a queue
// the operator sees as stuck while the worker sees it as taken is worse than no board.

export type DispatchableStudyRow = {
  id: number;
  tenantId: number;
  orderId: number;
  priority: 'stat' | 'urgent' | 'routine';
  subSpecialtyCode: string | null;
  modalityCode: string | null;
  tenantTimezone: string;
  receivedAt: Date;
};

export type PanelReaderRow = {
  userId: number;
  name: string;
  tenantId: number | null;
  subspecialtyCodes: string[];
  modalityCodes: string[];
  acceptsNight: boolean;
  maxQueueSize: number;
  declaredState: 'receiving' | 'paused' | 'away' | 'offline';
  lastSeenAt: Date | null;
  openCases: number;
  lastAssignedAt: Date | null;
  onShift: boolean;
};

export async function dispatchableStudies(
  db: Db,
  opts: { limit: number; tenantId?: number | null },
): Promise<DispatchableStudyRow[]> {
  const query = db.select({
    id: studies.id,
    tenantId: studies.tenantId,
    orderId: studies.orderId,
    priority: studies.priority,
    subSpecialtyCode: studies.subSpecialtyCode,
    modalityCode: studies.modalityCode,
    tenantTimezone: tenants.timezone,
    receivedAt: studies.receivedAt,
  }).from(studies)
    .innerJoin(tenants, eq(tenants.id, studies.tenantId))
    .where(and(
      eq(studies.linkState, 'linked'),
      isNotNull(studies.orderId),
      isNotNull(studies.tenantId),
      opts.tenantId === undefined || opts.tenantId === null ? undefined : eq(studies.tenantId, opts.tenantId),
      // A flagged study is not dispatchable. An unfinished series or an unattributed
      // site is a data problem, and routing it to a radiologist turns it into a
      // clinical one.
      sql`not exists (select 1 from jsonb_array_elements_text(${studies.qualityFlags}) f
                       where f in ('study_not_complete', 'site_unresolved'))`,
      sql`not exists (select 1 from ${assignments} a
                       where a.study_id = ${studies.id}
                         and a.state in ('offered', 'accepted', 'reading'))`,
    ))
    .orderBy(
      // Highest clinical need first, then the oldest wait. This is the whole of the
      // prioritisation policy, in one place, rather than something each caller re-decides.
      sql`case ${studies.priority} when 'stat' then 0 when 'urgent' then 1 else 2 end`,
      studies.receivedAt,
    )
    .limit(opts.limit);

  // No row lock here, deliberately. `FOR UPDATE OF telrad.studies` is refused by
  // Postgres (the OF list must be unqualified), and locking the joined tenants row per
  // study would serialise the sweep against tenant edits for no benefit: the unique
  // partial index on a live assignment is the arbiter, and two workers that both
  // decide to offer the same study end with one insert and one no-op.
  const rows = await query;

  return rows.map((row) => ({ ...row, tenantId: row.tenantId!, orderId: row.orderId! }));
}

export async function panelReaders(db: Db, tenantIds: number[], now: Date): Promise<PanelReaderRow[]> {
  const rows = await db.select({
    userId: users.id,
    name: users.displayName,
    tenantId: users.tenantId,
    subspecialtyCodes: clinicianProfiles.subspecialtyCodes,
    modalityCodes: clinicianProfiles.modalityCodes,
    acceptsNight: clinicianProfiles.acceptsNight,
    maxQueueSize: clinicianProfiles.maxQueueSize,
    declaredState: sql<PanelReaderRow['declaredState']>`coalesce(${readerAvailability.state}, 'offline')`,
    lastSeenAt: readerAvailability.lastSeenAt,
    openCases: sql<number>`(select count(*)::int from ${assignments} o
                             where o.clinician_user_id = ${users.id}
                               and o.state in ('offered', 'accepted', 'reading'))`,
    // Rotation reference: whoever has gone longest without a case. A reader who has
    // never had one sorts as longest of all, which is what makes a new joiner's first
    // case a decision rather than an accident.
    lastAssignedAt: sql<Date | null>`(select max(coalesce(o.accepted_at, o.offered_at))
                             from ${assignments} o where o.clinician_user_id = ${users.id})`,
    // ISO string with an explicit cast, not a Date: a Date interpolated into a raw sql
    // fragment reaches postgres.js untyped and throws while encoding it. The builder
    // comparisons elsewhere are safe because the column tells drizzle the type.
    onShift: sql<boolean>`exists (select 1 from ${rosters} sh
                      where sh.user_id = ${users.id} and sh.status <> 'cancelled'
                        and sh.starts_at <= ${now.toISOString()}::timestamptz
                        and sh.ends_at > ${now.toISOString()}::timestamptz)`,
  }).from(users)
    .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, users.id))
    .leftJoin(readerAvailability, eq(readerAvailability.userId, users.id))
    .where(and(
      // Inlined literals: an enum-typed inArray will not accept a string[] variable.
      inArray(users.role, ['radiologist', 'reviewer']),
      eq(users.status, 'active'),
      // A reader with no tenant is a platform reader and may serve any center; a
      // reader owned by a center may not see another center's work.
      or(isNull(users.tenantId), inArray(users.tenantId, tenantIds)),
    ))
    .orderBy(users.displayName);

  return rows.map((row) => ({
    ...row,
    subspecialtyCodes: row.subspecialtyCodes ?? [],
    modalityCodes: row.modalityCodes ?? [],
    openCases: row.openCases ?? 0,
  }));
}

/**
 * Who has already been asked about a study, and how many times. The rotation rule and
 * the console's "why is this nobody's case" answer both need it: a board that shows an
 * operator the reader the dispatcher has already offered and lost would send them to ask
 * that person twice while the case waits.
 */
export async function offerHistory(
  db: Db,
  studyIds: number[],
): Promise<Map<number, { userIds: number[]; maxAttempt: number }>> {
  if (studyIds.length === 0) return new Map();
  const rows = await db.select({
    studyId: assignments.studyId,
    userIds: sql<number[]>`array_agg(distinct ${assignments.clinicianUserId})`,
    attempts: sql<number>`max(${assignments.attemptNo})::int`,
  }).from(assignments)
    .where(inArray(assignments.studyId, studyIds))
    .groupBy(assignments.studyId);
  return new Map(rows.map((row) => [row.studyId, { userIds: row.userIds, maxAttempt: row.attempts }]));
}
