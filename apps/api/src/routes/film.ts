import { eq, sql } from 'drizzle-orm';
import { type Db, appendAudit, filmExports, patients, studies, tenants, users } from '@telrad/db';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const DESK_ROLES = ['owner', 'console'];

// Film exports are billed as a digital product: each CD, DVD, USB, or printed film set is
// a line item on the center's invoice. The tariff is stored on the tenant row so a center
// can change it without editing a tariff catalogue, and the price at the moment of export
// is stamped on the row so a later tariff change does not retroactively alter what was sold.

export function filmRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/film'], requireAuth(db)));

  r.post('/film/exports', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const studyId = Number(req.body?.studyId);
    const medium = String(req.body?.medium ?? '').toLowerCase();
    const quantity = Number(req.body?.quantity ?? 1);

    if (!Number.isInteger(studyId) || studyId < 1) {
      return res.status(400).json({ ok: false, error: 'studyId required' });
    }
    if (!['cd', 'dvd', 'usb', 'film_print', 'cloud_link'].includes(medium)) {
      return res.status(400).json({ ok: false, error: 'invalid_medium' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ ok: false, error: 'quantity must be 1 to 100' });
    }

    const [study] = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      accession: studies.accessionNumber,
      studyDescription: studies.studyDescription,
      patientName: patients.fullName,
    }).from(studies)
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .where(eq(studies.id, studyId))
      .limit(1);

    if (!study || !study.tenantId) return res.status(404).json({ ok: false, error: 'study_not_found' });
    if (principal.role !== 'owner' && study.tenantId !== principal.tenantId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const [tenant, operator] = await Promise.all([
      db.select({ filmTariff: tenants.filmExportTariffPaise }).from(tenants).where(eq(tenants.id, study.tenantId)).limit(1),
      db.select({ name: users.displayName }).from(users).where(eq(users.id, principal.userId)).limit(1),
    ]);

    const unitPaise = tenant[0]?.filmTariff ?? 50000;
    const totalPaise = unitPaise * quantity;
    const requestedByName = operator[0]?.name ?? principal.role;

    // The invoice line is not created here: a film export joins the next invoice draft
    // for the period, so ten exports on the last day of the month land on one invoice
    // rather than ten. The billing sweep picks up exports whose invoiceLineId is null.
    const exp = (await db.insert(filmExports).values({
      tenantId: study.tenantId,
      studyId,
      medium: medium as 'cd' | 'dvd' | 'usb' | 'film_print' | 'cloud_link',
      quantity,
      unitPaise,
      totalPaise,
      requestedByUserId: principal.userId,
      requestedByName,
      patientName: study.patientName,
      studyDescription: study.studyDescription,
    }).returning())[0];
    if (!exp) return res.status(500).json({ ok: false, error: 'insert_failed' });

    await appendAudit(db, {
      actorUserId: principal.userId,
      actorKind: 'human',
      tenantId: study.tenantId,
      action: 'film.exported',
      entity: 'film_exports',
      entityId: String(exp.id),
      detail: { studyId, medium, quantity, unitPaise, totalPaise },
    });

    res.status(201).json({
      ok: true,
      filmExportId: exp.id,
      unitPaise,
      totalPaise,
      medium,
      quantity,
    });
  }));

  r.get('/film/exports', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const principal = req.principal!;
    const tenantId = principal.role === 'owner' ? null : principal.tenantId;

    const rows = await db.select({
      id: filmExports.id,
      studyId: filmExports.studyId,
      medium: filmExports.medium,
      quantity: filmExports.quantity,
      unitPaise: filmExports.unitPaise,
      totalPaise: filmExports.totalPaise,
      requestedByName: filmExports.requestedByName,
      patientName: filmExports.patientName,
      studyDescription: filmExports.studyDescription,
      exportedAt: filmExports.exportedAt,
    }).from(filmExports)
      .where(tenantId === null ? sql`true` : eq(filmExports.tenantId, tenantId))
      .orderBy(sql`${filmExports.exportedAt} desc`)
      .limit(100);

    res.json({ ok: true, exports: rows });
  }));

  return r;
}
