import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  assignments,
  orders,
  patients,
  slaClocks,
  slaTargets,
  studies,
  subSpecialties,
  tenantSites,
} from '@telrad/db';
import { scoreOrder } from '@telrad/shared';
import { Router } from 'express';
import { requireAuth, scoped, scopeTenant, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

// DICOM dates are YYYYMMDD strings; the matcher compares those, not Date objects.
function iso(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function orphansRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/orphans', '/studies'], requireAuth(db)));

  // The queue an operator actually needs is not "rows with link_state != linked"
  // but rows plus the candidate the matcher would have chosen, because the fix is
  // almost always "that order" and making them re-derive it invites a wrong link.
  r.get('/orphans', ah(async (req: Ctx, res) => {
    const tenantId = scopeTenant(req.principal!);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    const rows = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      siteId: studies.siteId,
      studyInstanceUid: studies.studyInstanceUid,
      accessionNumber: studies.accessionNumber,
      modalityCode: studies.modalityCode,
      studyDescription: studies.studyDescription,
      receivedAt: studies.receivedAt,
      linkState: studies.linkState,
      qualityFlags: studies.qualityFlags,
      studyDate: studies.studyDate,
      provenance: sql<unknown>`(${studies.classification} -> 'provenance')`,
      siteName: tenantSites.name,
    }).from(studies)
      .leftJoin(tenantSites, eq(tenantSites.id, studies.siteId))
      .where(and(
        tenantId === null ? sql`true` : eq(studies.tenantId, tenantId),
        or(ne(studies.linkState, 'linked'), sql`${studies.orderId} is null`),
      ))
      .orderBy(desc(studies.receivedAt)).limit(limit);

    const withCandidates = await Promise.all(rows.map(async (row) => {
      if (!row.tenantId) return { ...row, candidates: [] };
      const candidates = await db.select({
        orderId: orders.id,
        accessionNumber: orders.accessionNumber,
        patientId: patients.id,
        patientName: patients.fullName,
        patientMrn: patients.mrn,
        dob: patients.dob,
        scheduledDate: orders.scheduledDate,
        modalityCode: orders.modalityCode,
        siteId: orders.siteId,
      }).from(orders)
        .leftJoin(patients, eq(patients.id, orders.patientId))
        .where(and(eq(orders.tenantId, row.tenantId), eq(orders.status, 'open')))
        .limit(50);

      // Re-scored with the *same* function the worker used, so the queue cannot
      // show an operator a different answer from the one the automation gave.
      const scored = candidates
        .map((c) => ({
          orderId: c.orderId,
          accessionNumber: c.accessionNumber,
          patientName: c.patientName,
          patientMrn: c.patientMrn,
          score: scoreOrder(
            {
              accessionNumber: row.accessionNumber ?? undefined,
              studyDate: row.studyDate ?? undefined,
              modalityCode: row.modalityCode ?? undefined,
              siteId: row.siteId ?? undefined,
              // The stored study keeps only the identity fields the queue needs to
              // re-score; a full re-read of DICOM here would be a per-row network
              // call into the image plane.
              patientName: undefined, patientId: undefined, patientBirthDate: undefined,
            },
            {
              orderId: c.orderId,
              accessionNumber: c.accessionNumber,
              patientName: c.patientName ?? null,
              patientMrn: c.patientMrn ?? null,
              dob: c.dob ? iso(c.dob) : null,
              studyDate: c.scheduledDate ? iso(c.scheduledDate) : null,
              modalityCode: c.modalityCode ?? null,
              siteId: c.siteId,
            },
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      return { ...row, candidates: scored };
    }));

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'orphans.list', entity: 'studies', detail: { count: rows.length },
    });
    res.json({ ok: true, orphans: withCandidates });
  }));

  r.post('/studies/:id/link', ah(async (req: Ctx, res) => {
    const studyId = Number(req.params.id);
    const orderId = Number(req.body?.orderId);
    const tenantId = scopeTenant(req.principal!);

    const [study] = await db.select().from(studies).where(eq(studies.id, studyId)).limit(1);
    if (!study || (tenantId !== null && study.tenantId !== tenantId)) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
    if (study.tenantId !== null && order.tenantId !== study.tenantId) {
      // Same answer as a missing order: an operator at one center must not be able
      // to probe whether an accession exists at another.
      return res.status(404).json({ ok: false, error: 'order_not_found' });
    }

    await db.update(studies).set({
      tenantId: order.tenantId,
      orderId: order.id,
      patientId: order.patientId,
      siteId: study.siteId ?? order.siteId,
      modalityCode: study.modalityCode ?? order.modalityCode,
      subSpecialtyCode: study.subSpecialtyCode ?? order.subSpecialtyCode,
      priority: study.priority === 'routine' ? order.priority : study.priority,
      linkState: 'linked',
      matchMethod: 'manual',
      matchScore: '1.000',
      linkedAt: new Date(),
      qualityFlags: (study.qualityFlags ?? []).filter((f) => f !== 'site_unresolved' && f !== 'region_unresolved'),
    }).where(eq(studies.id, studyId));

    // The clock must come from the same source the worker uses: a tenant's own
    // target for this modality and priority wins outright, otherwise the
    // sub-specialty's routine window with the stat/urgent fractions. Keeping the
    // two paths in lockstep is what stops a manually linked study being judged on
    // a different contract than one that arrived linked.
    let minutes: number | null = null;
    const modality = study.modalityCode ?? order.modalityCode;
    if (modality) {
      const [target] = await db.select({ m: slaTargets.slaMinutes })
        .from(slaTargets)
        .where(and(
          eq(slaTargets.tenantId, order.tenantId),
          eq(slaTargets.modalityCode, modality),
          eq(slaTargets.priority, order.priority),
          isNull(slaTargets.effectiveTo),
        ))
        .limit(1);
      if (target) minutes = target.m;
    }
    if (minutes === null) {
      const [sub] = await db.select({ minutes: subSpecialties.defaultSlaMinutes })
        .from(subSpecialties).where(eq(subSpecialties.code, order.subSpecialtyCode ?? '____')).limit(1);
      if (sub) {
        minutes = order.priority === 'stat' ? Math.max(Math.round(sub.minutes * 0.1), 30)
          : order.priority === 'urgent' ? Math.max(Math.round(sub.minutes * 0.5), 60) : sub.minutes;
      }
    }
    if (minutes !== null) {
      // Measured from when the center's pixels arrived, not from this click. A study
      // that sat in the orphan queue for three days does not get a fresh hour because
      // an operator finally named its order; the deadline being already past is the
      // fact the console has to show.
      const startedFrom = study.receivedAt;
      await db.insert(slaClocks)
        .values({
          studyId, tenantId: order.tenantId, priority: order.priority,
          deadlineAt: new Date(startedFrom.getTime() + minutes * 60_000),
        })
        .onConflictDoNothing();
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: order.tenantId,
      action: 'study.linked_manually', entity: 'studies', entityId: String(studyId),
      detail: { orderId: order.id, accession: order.accessionNumber, previousState: study.linkState },
    });
    res.json({ ok: true, studyId, orderId: order.id });
  }));

  r.post('/studies/:id/unlink', ah(async (req: Ctx, res) => {
    const studyId = Number(req.params.id);
    const tenantId = scopeTenant(req.principal!);
    const [study] = await db.select().from(studies).where(eq(studies.id, studyId)).limit(1);
    if (!study || (tenantId !== null && study.tenantId !== tenantId)) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // Once a radiologist holds the case, unlinking it would silently retract work
    // in progress. The lock has to be released first, deliberately and in view.
    const live = await db.select({ id: assignments.id }).from(assignments)
      .where(and(eq(assignments.studyId, studyId), sql`${assignments.state} in ('offered','accepted','reading')`))
      .limit(1);
    if (live[0]) return res.status(409).json({ ok: false, error: 'assignment_open', assignmentId: live[0].id });

    await db.update(studies).set({
      orderId: null, patientId: null, linkState: 'orphan', matchMethod: 'none', matchScore: '0.000', linkedAt: null,
    }).where(eq(studies.id, studyId));
    await db.delete(slaClocks).where(and(eq(slaClocks.studyId, studyId), sql`${slaClocks.signedAt} is null`));

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: study.tenantId,
      action: 'study.unlinked', entity: 'studies', entityId: String(studyId),
      detail: { previousOrderId: study.orderId },
    });
    res.json({ ok: true, studyId });
  }));

  return r;
}
