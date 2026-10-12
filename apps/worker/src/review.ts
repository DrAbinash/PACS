import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { appendAudit, auditLog, reports, studies, subSpecialties } from '@telrad/db';

// A signed report waiting for a second name is a different thing from an unsigned one:
// the center was already answered on time, so the contract clock correctly stops at the
// signature. But a report that has sat unreviewed for six hours is an operational problem
// even when it is not a contractual one — the reviewer queue shows reviewers what is
// waiting, and nobody tells the operator that it has been waiting since 02:13. This sweep
// is the notification half of that gap.

// Two hours: a routine report waiting longer than this is not an emergency, but it is a
// case of "somebody went home without clearing their queue" or "the only full cover is
// paused and nothing widened to them". The number is operational, not contractual — a
// tenant that wants a different threshold can patch it, but the default is chosen so a
// report that has been sitting through a whole shift is the one that pages.
const WAITING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type ReviewSweepResult = {
  checked: number;
  alerted: number;
};

/**
 * Find signed reports waiting for a second name and alert the operator when they have
 * been waiting too long. One audit row per report per hour — a report that has been
 * waiting for three hours produces three rows, so the chain records how long the
 * operator knew and did not act.
 */
export async function reviewSweepOnce(db: Db): Promise<ReviewSweepResult> {
  const threshold = new Date(Date.now() - WAITING_THRESHOLD_MS);

  // The rule the query asks is the rule the delivery gate enforces: on a sub-specialty that
  // needs no second name, a signed report is deliverable, not stuck, and paging "waiting for
  // a reviewer" on it misreads a normal state as a fault. The inner join also drops a study
  // with no sub-specialty — the same `?? false` the report view applies to a missing rule.
  const rows = await db.select({
    reportId: reports.id,
    studyId: reports.studyId,
    tenantId: reports.tenantId,
    signedAt: reports.signedAt,
    accession: studies.accessionNumber,
  }).from(reports)
    .innerJoin(studies, eq(studies.id, reports.studyId))
    .innerJoin(subSpecialties, eq(subSpecialties.code, studies.subSpecialtyCode))
    .where(and(
      eq(reports.state, 'signed'),
      isNull(reports.reviewerUserId),
      eq(subSpecialties.requiresReviewer, true),
      lt(reports.signedAt, threshold),
    ))
    .limit(100);

  let alerted = 0;
  for (const row of rows) {
    const signedAt = row.signedAt!;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [existing] = await db.select({ id: sql<number>`1` })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, 'review.waiting_long'),
        eq(auditLog.entityId, String(row.reportId)),
        sql`${auditLog.occurredAt} > ${oneHourAgo}`,
      ))
      .limit(1);

    if (existing) continue;

    const waitingMinutes = Math.round((Date.now() - signedAt.getTime()) / 60000);
    await appendAudit(db, {
      actorUserId: null,
      actorKind: 'system',
      tenantId: row.tenantId,
      action: 'review.waiting_long',
      entity: 'reports',
      entityId: String(row.reportId),
      detail: {
        studyId: row.studyId,
        accession: row.accession,
        signedAt,
        waitingMinutes,
      },
    });
    alerted += 1;
  }

  return { checked: rows.length, alerted };
}
