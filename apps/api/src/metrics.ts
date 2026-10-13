import { sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, type Ctx } from './auth.js';
import { ah } from './handler.js';

const CONSOLE_ROLES = ['owner', 'console'];

export function metricsRouter(db: Db): Router {
  const r = Router();

  // Prometheus-compatible metrics endpoint. Returns text/plain in the exposition format.
  // Kept behind auth so a public endpoint cannot leak operational details.
  r.get('/metrics', requireAuth(db), ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, CONSOLE_ROLES, res)) return undefined;

    const metrics: string[] = [];

    // Database connection pool stats
    const poolStats = (await db.execute<{
      active_connections: number;
      idle_connections: number;
      waiting_requests: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections,
        COUNT(*) FILTER (WHERE state = 'idle')::int AS idle_connections,
        0 AS waiting_requests
      FROM pg_stat_activity
      WHERE backend_type = 'client backend'
    `))[0] ?? { active_connections: 0, idle_connections: 0, waiting_requests: 0 };
    metrics.push('# HELP db_pool_active Active database connections');
    metrics.push('# TYPE db_pool_active gauge');
    metrics.push(`db_pool_active ${poolStats.active_connections}`);
    metrics.push('# HELP db_pool_idle Idle database connections');
    metrics.push('# TYPE db_pool_idle gauge');
    metrics.push(`db_pool_idle ${poolStats.idle_connections}`);

    // Assignment states
    const assignmentStats = (await db.execute<{
      offered: number;
      accepted: number;
      reading: number;
      returned: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE state = 'offered')::int AS offered,
        COUNT(*) FILTER (WHERE state = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE state = 'reading')::int AS reading,
        COUNT(*) FILTER (WHERE state = 'returned')::int AS returned
      FROM telrad.assignments
      WHERE state IN ('offered', 'accepted', 'reading', 'returned')
    `))[0] ?? { offered: 0, accepted: 0, reading: 0, returned: 0 };
    metrics.push('# HELP assignments_by_state Current assignment counts by state');
    metrics.push('# TYPE assignments_by_state gauge');
    metrics.push(`assignments_by_state{state="offered"} ${assignmentStats.offered}`);
    metrics.push(`assignments_by_state{state="accepted"} ${assignmentStats.accepted}`);
    metrics.push(`assignments_by_state{state="reading"} ${assignmentStats.reading}`);
    metrics.push(`assignments_by_state{state="returned"} ${assignmentStats.returned}`);

    // SLA breaches
    const slaStats = (await db.execute<{ breached: number; open: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE breached = true)::int AS breached,
        COUNT(*) FILTER (WHERE signed_at IS NULL)::int AS open
      FROM telrad.sla_clocks
    `))[0] ?? { breached: 0, open: 0 };
    metrics.push('# HELP sla_breached_count Number of SLA breaches');
    metrics.push('# TYPE sla_breached_count gauge');
    metrics.push(`sla_breached_count ${slaStats.breached}`);
    metrics.push('# HELP sla_open_count Open SLA clocks (unsigned)');
    metrics.push('# TYPE sla_open_count gauge');
    metrics.push(`sla_open_count ${slaStats.open}`);

    // Critical events
    const criticalStats = (await db.execute<{ unacked: number }>(sql`
      SELECT COUNT(*)::int AS unacked
      FROM telrad.critical_events
      WHERE acknowledged_at IS NULL
    `))[0] ?? { unacked: 0 };
    metrics.push('# HELP critical_events_unacknowledged Unacknowledged critical events');
    metrics.push('# TYPE critical_events_unacknowledged gauge');
    metrics.push(`critical_events_unacknowledged ${criticalStats.unacked}`);

    // Report states
    const reportStats = (await db.execute<{
      draft: number;
      signed: number;
      verified: number;
      delivered: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE state = 'draft')::int AS draft,
        COUNT(*) FILTER (WHERE state = 'signed')::int AS signed,
        COUNT(*) FILTER (WHERE state = 'verified')::int AS verified,
        COUNT(*) FILTER (WHERE state = 'delivered')::int AS delivered
      FROM telrad.reports
      WHERE state IN ('draft', 'signed', 'verified', 'delivered')
    `))[0] ?? { draft: 0, signed: 0, verified: 0, delivered: 0 };
    metrics.push('# HELP reports_by_state Current report counts by state');
    metrics.push('# TYPE reports_by_state gauge');
    metrics.push(`reports_by_state{state="draft"} ${reportStats.draft}`);
    metrics.push(`reports_by_state{state="signed"} ${reportStats.signed}`);
    metrics.push(`reports_by_state{state="verified"} ${reportStats.verified}`);
    metrics.push(`reports_by_state{state="delivered"} ${reportStats.delivered}`);

    // Delivery queue
    const deliveryStats = (await db.execute<{ pending: number; failed: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM telrad.report_deliveries
      WHERE status IN ('pending', 'failed')
    `))[0] ?? { pending: 0, failed: 0 };
    metrics.push('# HELP deliveries_pending Pending report deliveries');
    metrics.push('# TYPE deliveries_pending gauge');
    metrics.push(`deliveries_pending ${deliveryStats.pending}`);
    metrics.push('# HELP deliveries_failed Failed report deliveries');
    metrics.push('# TYPE deliveries_failed gauge');
    metrics.push(`deliveries_failed ${deliveryStats.failed}`);

    res.type('text/plain').send(metrics.join('\n') + '\n');
  }));

  return r;
}
