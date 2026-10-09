import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  orders,
  patients,
  tenantSites,
} from '@telrad/db';
import { cleanText, normaliseMrn, validateOrderInput, validatePatientInput } from '@telrad/shared';
import { Router } from 'express';
import { requireAuth, scoped, scopeTenant, type Ctx } from '../auth.js';

// The tenant a write lands in is decided here, once: a center role is pinned to its
// own tenant, and owner/console must name one explicitly. There is no path where an
// omitted parameter means "all tenants".
function actorTenant(req: Ctx): number | null {
  const p = req.principal!;
  if (p.role === 'owner' || p.role === 'console') {
    const named = Number(req.body?.tenantId ?? req.query.tenant_id);
    return Number.isInteger(named) ? named : null;
  }
  return p.tenantId;
}

export function clinicalRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/patients', '/orders'], requireAuth(db)));

  r.post('/patients', async (req: Ctx, res) => {
    const tenantId = actorTenant(req);
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_required' });

    const v = validatePatientInput(req.body ?? {});
    if (!v.ok) return res.status(422).json({ ok: false, error: 'invalid_patient', violations: v.violations });

    const mrn = normaliseMrn(req.body.mrn);
    const clash = await db.select({ id: patients.id }).from(patients)
      .where(and(eq(patients.tenantId, tenantId), eq(patients.mrn, mrn))).limit(1);
    if (clash[0]) {
      // The same person re-registered at the same desk is the common case, so the
      // answer is the existing id, not an error the receptionist has to read about.
      return res.status(200).json({ ok: true, patient: clash[0], idempotent: true });
    }

    const dob = cleanText(req.body.dob ?? '', 10).replace(/-/g, '');
    const [row] = await db.insert(patients).values({
      tenantId,
      mrn,
      fullName: cleanText(req.body.fullName, 160),
      gender: (cleanText(req.body.gender ?? 'U', 1).toUpperCase() || 'U') as 'M' | 'F' | 'X' | 'U',
      dob: dob ? new Date(`${dob.slice(0, 4)}-${dob.slice(4, 6)}-${dob.slice(6, 8)}T00:00:00Z`) : null,
      phone: cleanText(req.body.phone ?? '', 20) || null,
      abdmAbhaId: cleanText(req.body.abdmAbhaId ?? '', 32) || null,
    }).returning();

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'patient.created', entity: 'patients', entityId: String(row!.id),
      detail: { mrn },
    });
    res.status(201).json({ ok: true, patient: row });
  });

  r.get('/patients', async (req: Ctx, res) => {
    const tenantId = scopeTenant(req.principal!);
    const q = cleanText(req.query.q ?? '', 64);
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    const rows = await db.select().from(patients)
      .where(and(
        tenantId === null ? sql`true` : eq(patients.tenantId, tenantId),
        q ? or(sql`lower(${patients.mrn}) like lower(${`%${q}%`})`, sql`lower(${patients.fullName}) like lower(${`%${q}%`})`) : undefined,
      ))
      .orderBy(desc(patients.createdAt)).limit(limit);
    res.json({ ok: true, patients: rows });
  });

  r.post('/orders', async (req: Ctx, res) => {
    const tenantId = actorTenant(req);
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_required' });

    const v = validateOrderInput(req.body ?? {});
    if (!v.ok) return res.status(422).json({ ok: false, error: 'invalid_order', violations: v.violations });

    const patientRows = await db.select().from(patients)
      .where(and(eq(patients.id, Number(req.body.patientId)), eq(patients.tenantId, tenantId))).limit(1);
    const patient = patientRows[0];
    if (!patient) {
      return res.status(422).json({ ok: false, error: 'invalid_order', violations: [{ field: 'patientId', message: 'not in this tenant' }] });
    }

    const siteId = req.body.siteId === undefined || req.body.siteId === null ? null : Number(req.body.siteId);
    if (siteId !== null) {
      const site = await db.select({ id: tenantSites.id }).from(tenantSites)
        .where(and(eq(tenantSites.id, siteId), eq(tenantSites.tenantId, tenantId))).limit(1);
      if (!site[0]) return res.status(422).json({ ok: false, error: 'invalid_order', violations: [{ field: 'siteId', message: 'not in this tenant' }] });
    }

    const acc = cleanText(req.body.accessionNumber, 64).toUpperCase();
    const existing = await db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.tenantId, tenantId), sql`upper(${orders.accessionNumber}) = ${acc}`)).limit(1);
    if (existing[0]) {
      return res.status(200).json({ ok: true, order: existing[0], idempotent: true });
    }

    const sched = cleanText(req.body.scheduledDate ?? '', 10).replace(/-/g, '');
    const [row] = await db.insert(orders).values({
      tenantId,
      siteId,
      accessionNumber: acc,
      patientId: patient.id,
      modalityCode: cleanText(req.body.modalityCode, 4).toUpperCase(),
      bodyPartCode: cleanText(req.body.bodyPartCode ?? '', 24).toUpperCase() || null,
      subSpecialtyCode: cleanText(req.body.subSpecialtyCode ?? '', 32).toLowerCase() || null,
      priority: cleanText(req.body.priority, 8).toLowerCase() as 'stat' | 'urgent' | 'routine',
      clinicalIndication: cleanText(req.body.clinicalIndication ?? '', 2000) || null,
      referringName: cleanText(req.body.referringName ?? '', 160) || null,
      referringPhone: cleanText(req.body.referringPhone ?? '', 20) || null,
      referringRegistration: cleanText(req.body.referringRegistration ?? '', 40) || null,
      studyDescription: cleanText(req.body.studyDescription ?? '', 160) || null,
      scheduledDate: sched.length === 8 ? new Date(`${sched.slice(0, 4)}-${sched.slice(4, 6)}-${sched.slice(6, 8)}T00:00:00Z`) : null,
      source: 'portal',
    }).returning();

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'order.created', entity: 'orders', entityId: String(row!.id),
      detail: { accession: row!.accessionNumber, modality: row!.modalityCode, priority: row!.priority },
    });
    res.status(201).json({ ok: true, order: row });
  });

  r.patch('/orders/:id', async (req: Ctx, res) => {
    const id = Number(req.params.id);
    const tenantId = scopeTenant(req.principal!);
    const rows = await db.select().from(orders)
      .where(and(eq(orders.id, id), tenantId === null ? sql`true` : eq(orders.tenantId, tenantId))).limit(1);
    const order = rows[0];
    if (!order) return res.status(404).json({ ok: false, error: 'not_found' });

    const patch: Record<string, unknown> = {};
    if (req.body?.priority) {
      const p = cleanText(req.body.priority, 8).toLowerCase();
      if (!['stat', 'urgent', 'routine'].includes(p)) return res.status(422).json({ ok: false, error: 'bad_priority' });
      patch.priority = p;
    }
    if (req.body?.status) {
      const s = cleanText(req.body.status, 16).toLowerCase();
      if (!['open', 'scheduled', 'completed', 'cancelled'].includes(s)) return res.status(422).json({ ok: false, error: 'bad_status' });
      patch.status = s;
    }
    if (req.body?.clinicalIndication !== undefined) patch.clinicalIndication = cleanText(req.body.clinicalIndication, 2000);

    if (Object.keys(patch).length === 0) return res.status(422).json({ ok: false, error: 'nothing_to_change' });

    // Accession is deliberately not editable: images already in the archive carry
    // it, and a silent rename would orphan studies that are physically present.
    await db.update(orders).set(patch).where(eq(orders.id, id));
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: order.tenantId,
      action: 'order.updated', entity: 'orders', entityId: String(id), detail: patch,
    });
    res.json({ ok: true, id });
  });

  r.get('/orders', async (req: Ctx, res) => {
    const tenantId = scopeTenant(req.principal!);
    const state = cleanText(req.query.state ?? 'open', 16).toLowerCase();
    const allowed = ['open', 'scheduled', 'completed', 'cancelled', 'all'] as const;
    if (!(allowed as readonly string[]).includes(state)) {
      return res.status(400).json({ ok: false, error: 'bad_state' });
    }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = await db.select({
      id: orders.id, accessionNumber: orders.accessionNumber, modalityCode: orders.modalityCode,
      priority: orders.priority, status: orders.status, scheduledDate: orders.scheduledDate,
      patientName: patients.fullName, patientMrn: patients.mrn, orderedAt: orders.orderedAt,
      studyCount: sql<number>`(select count(*)::int from telrad.studies s where s.order_id = ${orders.id})`,
    }).from(orders)
      .leftJoin(patients, eq(patients.id, orders.patientId))
      .where(and(
        tenantId === null ? sql`true` : eq(orders.tenantId, tenantId),
        state === 'all' ? undefined : eq(orders.status, state as 'open' | 'scheduled' | 'completed' | 'cancelled'),
      ))
      .orderBy(desc(orders.orderedAt)).limit(limit);
    res.json({ ok: true, orders: rows });
  });

  return r;
}
