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

  // The tenant's own profile, scoped to the caller. A center user sees only their
  // own tenant; the platform owner can ask for any id or omit it to see all.
  r.get('/tenants/profile', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return undefined;
    const p = req.principal!;
    const idParam = req.query.id ? Number(req.query.id) : null;
    if (idParam !== null && !Number.isInteger(idParam)) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }
    // A scoped center user must never be able to pass an id that isn't theirs —
    // the server overrides the parameter rather than trusting it.
    const id = p.tenantId !== null ? p.tenantId : idParam;
    if (id === null) {
      const rows = await db.select().from(tenants);
      return res.json({ ok: true, tenants: rows });
    }
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, tenant });
  }));

  // Tenant profile edits: the center's legal name, billing name, GSTIN, contact
  // block, and signature line. Owner-only — a console operator can read but the
  // legal identity of a center is the owner's call. Every field is audited.
  r.patch('/tenants/profile', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OWNER_ONLY, res)) return undefined;
    const p = req.principal!;
    if (p.tenantId === null) {
      return res.status(403).json({ ok: false, error: 'platform owner has no tenant profile' });
    }
    const body = req.body ?? {};
    const changes: Record<string, unknown> = {};
    const text = (k: string, max: number): string | null => {
      if (body[k] === undefined) return undefined as unknown as null;
      if (body[k] === null) return null;
      const s = String(body[k]).trim();
      if (s.length > max) throw new Error(`${k} longer than ${max} characters`);
      return s;
    };
    try {
      const legalName = text('legalName', 200);
      const billingName = text('billingName', 200);
      const country = text('country', 80);
      const stateCode = text('stateCode', 16);
      const gstin = text('gstin', 32);
      const timezone = text('timezone', 64);
      const contactName = text('contactName', 160);
      const contactEmail = text('contactEmail', 200);
      const contactPhone = text('contactPhone', 40);
      const signatureLine = text('signatureLine', 400);
      for (const [k, v] of Object.entries({ legalName, billingName, country, stateCode, gstin, timezone, contactName, contactEmail, contactPhone, signatureLine })) {
        if (v !== undefined) changes[k] = v;
      }
    } catch (err) {
      return res.status(422).json({ ok: false, error: err instanceof Error ? err.message : 'invalid input' });
    }

    if (Object.keys(changes).length === 0) {
      return res.status(422).json({ ok: false, error: 'no fields to update' });
    }

    const [before] = await db.select().from(tenants).where(eq(tenants.id, p.tenantId)).limit(1);
    await db.update(tenants).set(changes).where(eq(tenants.id, p.tenantId));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'tenant.profile', entity: 'tenants', entityId: String(p.tenantId),
      detail: { changes, prior: Object.fromEntries(Object.keys(changes).map((k) => [k, (before as Record<string, unknown>)[k]])) },
    });

    const [after] = await db.select().from(tenants).where(eq(tenants.id, p.tenantId)).limit(1);
    res.json({ ok: true, tenant: after });
  }));

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
