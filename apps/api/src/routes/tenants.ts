import { eq } from 'drizzle-orm';
import { type Db, appendAudit, tenants } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const OWNER_ONLY = ['owner'];
// A fat-fingered 999999 is forever with extra steps, so the ceiling is a century.
const MAX_RETENTION_DAYS = 36500;

// Per-tenant image retention, in days from receipt. Pixels only: the report, the
// billable events, the invoice and the audit chain survive a purge, and a pinned
// study is never swept. NULL means the center's images are kept forever.
export function tenantsRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/tenants'], requireAuth(db)));

  r.get('/tenants/retention', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return undefined;
    const principal = req.principal!;
    // A center sees its own row; the platform owner sees every center's, which is
    // the table the settings card renders.
    const rows = await db.select({
      tenantId: tenants.id,
      code: tenants.code,
      legalName: tenants.legalName,
      retentionDays: tenants.retentionDays,
    }).from(tenants)
      .where(principal.tenantId === null ? undefined : eq(tenants.id, principal.tenantId));
    res.json({ ok: true, retention: rows });
  }));

  r.patch('/tenants/:id/retention', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OWNER_ONLY, res)) return undefined;
    const principal = req.principal!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    if (principal.tenantId !== null && principal.tenantId !== id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const raw = req.body?.retentionDays;
    if (raw !== null && !Number.isInteger(raw)) {
      return res.status(400).json({ ok: false, error: 'retentionDays must be an integer or null' });
    }
    if (raw !== null && (raw < 1 || raw > MAX_RETENTION_DAYS)) {
      return res.status(400).json({
        ok: false,
        error: `retentionDays must be 1 to ${MAX_RETENTION_DAYS} days, or null to keep images forever`,
      });
    }
    const retentionDays = raw as number | null;

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.update(tenants).set({ retentionDays }).where(eq(tenants.id, id));

    await appendAudit(db, {
      actorUserId: principal.userId,
      actorKind: 'human',
      tenantId: id,
      action: 'retention.policy_set',
      entity: 'tenants',
      entityId: String(id),
      detail: { retentionDays, previousRetentionDays: tenant.retentionDays },
    });

    res.json({ ok: true, tenantId: id, retentionDays });
  }));

  return r;
}
