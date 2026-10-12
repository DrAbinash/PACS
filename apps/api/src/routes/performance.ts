import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { type Db, assignments, reports, users } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const DESK_ROLES = ['owner', 'console'];

// Reader performance metrics: studies read per day, average TAT, acceptance rate, decline rate.
// The desk uses this to see who is carrying weight and who is not, and a reader uses it to see
// their own throughput. A center that cannot measure its readers cannot manage them.

export function performanceRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/performance'], requireAuth(db)));

  r.get('/performance/readers', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const tenantId = principal.role === 'owner' ? null : principal.tenantId;

    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();

    // Per-reader aggregates over the date range: offered count, accepted, declined, completed,
    // average time from offer to accept, average time from accept to signed.
    const rows = await db.select({
      userId: users.id,
      name: users.displayName,
      role: users.role,
      offered: sql<number>`count(*) filter (where ${assignments.state} in ('offered','accepted','reading','completed','returned'))::int`,
      accepted: sql<number>`count(*) filter (where ${assignments.state} in ('accepted','reading','completed'))::int`,
      declined: sql<number>`count(*) filter (where ${assignments.state} = 'returned')::int`,
      completed: sql<number>`count(*) filter (where ${assignments.state} = 'completed')::int`,
      // Average seconds from offer to accept, for cases that were accepted.
      avgAcceptSeconds: sql<number>`extract(epoch from avg(${assignments.acceptedAt} - ${assignments.offeredAt}))::int`,
      // Average seconds from accept to report signed, for cases that were completed.
      avgReadSeconds: sql<number>`extract(epoch from avg(${reports.signedAt} - ${assignments.acceptedAt}))::int`,
    }).from(users)
      .leftJoin(assignments, and(
        eq(assignments.clinicianUserId, users.id),
        gte(assignments.offeredAt, from),
        lte(assignments.offeredAt, to),
      ))
      .leftJoin(reports, and(
        eq(reports.studyId, assignments.studyId),
        eq(reports.authorUserId, users.id),
      ))
      .where(and(
        eq(users.role, 'radiologist'),
        tenantId === null ? sql`true` : eq(users.tenantId, tenantId),
      ))
      .groupBy(users.id, users.displayName, users.role)
      .orderBy(desc(sql`count(*) filter (where ${assignments.state} = 'completed')`));

    res.json({
      ok: true,
      from,
      to,
      readers: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        offered: r.offered,
        accepted: r.accepted,
        declined: r.declined,
        completed: r.completed,
        acceptanceRate: r.offered > 0 ? Math.round((r.accepted / r.offered) * 100) : 0,
        avgAcceptSeconds: r.avgAcceptSeconds,
        avgReadSeconds: r.avgReadSeconds,
        studiesPerDay: r.completed / Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400_000)),
      })),
    });
  }));

  return r;
}
