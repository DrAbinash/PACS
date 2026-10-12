import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Db, appendAudit, slaTargets } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const DESK_ROLES = ['owner', 'console'];

// SLA targets: per-tenant, per-modality, per-priority TAT targets. A center configures
// these to override the sub-specialty defaults. The dispatch logic reads the active
// target for each study and uses it to compute the deadline.

export function slaRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/sla'], requireAuth(db)));

  r.get('/sla/targets', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const tenantId = principal.role === 'owner' ? null : principal.tenantId;

    const rows = await db.select().from(slaTargets)
      .where(and(
        tenantId === null ? sql`true` : eq(slaTargets.tenantId, tenantId),
        isNull(slaTargets.effectiveTo),
      ))
      .orderBy(slaTargets.tenantId, slaTargets.modalityCode, slaTargets.priority);

    res.json({ ok: true, targets: rows });
  }));

  r.post('/sla/targets', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const tenantId = principal.role === 'owner'
      ? Number(req.body?.tenantId)
      : principal.tenantId;

    if (!Number.isInteger(tenantId)) {
      return res.status(400).json({ ok: false, error: 'tenantId required' });
    }
    const tid = tenantId as number;

    const modalityCode = String(req.body?.modalityCode ?? '').toUpperCase();
    const priorityRaw = String(req.body?.priority ?? '').toLowerCase();
    const slaMinutes = Number(req.body?.slaMinutes);

    if (!modalityCode || modalityCode.length > 4) {
      return res.status(400).json({ ok: false, error: 'modalityCode required (max 4 chars)' });
    }
    if (!['stat', 'urgent', 'routine'].includes(priorityRaw)) {
      return res.status(400).json({ ok: false, error: 'priority must be stat, urgent, or routine' });
    }
    const priority = priorityRaw as 'stat' | 'urgent' | 'routine';
    if (!Number.isInteger(slaMinutes) || slaMinutes < 1 || slaMinutes > 10080) {
      return res.status(400).json({ ok: false, error: 'slaMinutes must be 1 to 10080 (1 week)' });
    }

    // Close any existing active target for this combination. A center that has two active
    // rows for the same modality/priority has a configuration error, and the unique index
    // refuses it; we close the old one rather than failing the insert.
    await db.update(slaTargets).set({ effectiveTo: new Date() })
      .where(and(
        eq(slaTargets.tenantId, tid),
        eq(slaTargets.modalityCode, modalityCode),
        eq(slaTargets.priority, priority),
        isNull(slaTargets.effectiveTo),
      ));

    const target = (await db.insert(slaTargets).values({
      tenantId: tid,
      modalityCode,
      priority,
      slaMinutes,
      effectiveFrom: new Date(),
    }).returning())[0];
    if (!target) return res.status(500).json({ ok: false, error: 'insert_failed' });

    await appendAudit(db, {
      actorUserId: principal.userId,
      actorKind: 'human',
      tenantId: tid,
      action: 'sla.target_created',
      entity: 'sla_targets',
      entityId: String(target.id),
      detail: { modalityCode, priority, slaMinutes },
    });

    res.status(201).json({ ok: true, target });
  }));

  r.delete('/sla/targets/:id', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }

    const [target] = await db.select().from(slaTargets).where(eq(slaTargets.id, id)).limit(1);
    if (!target) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (principal.role !== 'owner' && target.tenantId !== principal.tenantId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    await db.update(slaTargets).set({ effectiveTo: new Date() }).where(eq(slaTargets.id, id));

    await appendAudit(db, {
      actorUserId: principal.userId,
      actorKind: 'human',
      tenantId: target.tenantId,
      action: 'sla.target_deactivated',
      entity: 'sla_targets',
      entityId: String(id),
    });

    res.json({ ok: true });
  }));

  return r;
}
