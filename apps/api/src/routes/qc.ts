import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { type Db, assignments, criticalEvents, slaClocks, studies } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const DESK_ROLES = ['owner', 'console'];

// The NHC QC indicators are the numbers a center's quality review meets on: how often
// images arrive unreadable, how fast STAT cases are answered, how quickly critical findings
// reach the referring clinician. They are computed over a date range so a monthly review
// and a year-end audit can run the same endpoint with different parameters.

export function qcRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/qc'], requireAuth(db)));

  r.get('/qc/indicators', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();
    const tenantId = principal.role === 'owner' ? null : principal.tenantId;

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ ok: false, error: 'invalid_date_range' });
    }

    const scope = tenantId === null ? sql`true` : eq(studies.tenantId, tenantId);
    const dateRange = and(
      gte(studies.receivedAt, from),
      lte(studies.receivedAt, to),
      scope,
    );

    // Total studies in the period — the denominator for every rate below.
    const [total] = await db.select({ n: sql<number>`count(*)::int` })
      .from(studies).where(dateRange);
    const totalStudies = total?.n ?? 0;

    // Artifact rate: studies flagged with 'study_not_complete' or 'site_unresolved' at
    // intake. A study that arrived broken is a quality failure at the source, not at the
    // reader's desk, but the center still owns the number.
    const [artifact] = await db.select({ n: sql<number>`count(*)::int` })
      .from(studies).where(and(
        dateRange,
        sql`exists (select 1 from jsonb_array_elements_text(${studies.qualityFlags}) f
                    where f in ('study_not_complete', 'site_unresolved'))`,
      ));
    const artifactCount = artifact?.n ?? 0;
    const artifactRate = totalStudies > 0 ? artifactCount / totalStudies : 0;

    // Emergency completion: STAT studies whose report was signed within 30 minutes of
    // receipt. The SLA clock's signed_at is the moment the second name landed; the
    // threshold is the NHC's emergency reporting standard.
    const [emergency] = await db.select({
      total: sql<number>`count(*)::int`,
      within: sql<number>`count(*) filter (where ${slaClocks.signedAt} is not null
                                          and extract(epoch from ${slaClocks.signedAt} - ${studies.receivedAt}) <= 1800)::int`,
    }).from(studies)
      .innerJoin(slaClocks, eq(slaClocks.studyId, studies.id))
      .where(and(dateRange, eq(studies.priority, 'stat')));
    const emergencyTotal = emergency?.total ?? 0;
    const emergencyWithin = emergency?.within ?? 0;
    const emergencyCompliance = emergencyTotal > 0 ? emergencyWithin / emergencyTotal : 0;

    // Critical notification: critical findings acknowledged by the referring clinician
    // within 15 minutes. The critical_events table tracks when each finding was notified
    // and when it was acknowledged; the threshold is the closed-loop standard.
    const [critical] = await db.select({
      total: sql<number>`count(*)::int`,
      within: sql<number>`count(*) filter (where ${criticalEvents.acknowledgedAt} is not null
                                          and ${criticalEvents.notifiedAt} is not null
                                          and extract(epoch from ${criticalEvents.acknowledgedAt} - ${criticalEvents.notifiedAt}) <= 900)::int`,
    }).from(criticalEvents)
      .where(and(
        gte(criticalEvents.detectedAt, from),
        lte(criticalEvents.detectedAt, to),
        tenantId === null ? sql`true` : eq(criticalEvents.tenantId, tenantId),
        sql`${criticalEvents.notifiedAt} is not null`,
      ));
    const criticalTotal = critical?.total ?? 0;
    const criticalWithin = critical?.within ?? 0;
    const criticalCompliance = criticalTotal > 0 ? criticalWithin / criticalTotal : 0;

    // Report turnaround: median and p95 from receipt to signed, in minutes. The median
    // is what the monthly review quotes; the p95 is what the audit asks for.
    const [tat] = await db.select({
      median: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from ${slaClocks.signedAt} - ${studies.receivedAt}) / 60)`,
      p95: sql<number>`percentile_cont(0.95) within group (order by extract(epoch from ${slaClocks.signedAt} - ${studies.receivedAt}) / 60)`,
    }).from(studies)
      .innerJoin(slaClocks, eq(slaClocks.studyId, studies.id))
      .where(and(dateRange, sql`${slaClocks.signedAt} is not null`));
    const tatMedian = tat?.median ?? null;
    const tatP95 = tat?.p95 ?? null;

    // Rejection rate: studies whose assignment was returned with reason 'declined' more
    // than once. A single decline is a reader saying "not my subspecialty"; two is a
    // routing gap the center has to close.
    const [rejection] = await db.select({ n: sql<number>`count(distinct ${assignments.studyId})::int` })
      .from(assignments)
      .where(and(
        gte(assignments.offeredAt, from),
        lte(assignments.offeredAt, to),
        tenantId === null ? sql`true` : eq(assignments.tenantId, tenantId),
        eq(assignments.returnReason, 'declined'),
      ));
    const rejectionCount = rejection?.n ?? 0;
    const rejectionRate = totalStudies > 0 ? rejectionCount / totalStudies : 0;

    res.json({
      ok: true,
      from,
      to,
      totalStudies,
      indicators: {
        artifactRate: { count: artifactCount, rate: artifactRate },
        emergencyCompliance: { total: emergencyTotal, within30min: emergencyWithin, rate: emergencyCompliance },
        criticalCompliance: { total: criticalTotal, within15min: criticalWithin, rate: criticalCompliance },
        turnaroundMinutes: { median: tatMedian, p95: tatP95 },
        rejectionRate: { count: rejectionCount, rate: rejectionRate },
      },
    });
  }));

  return r;
}
