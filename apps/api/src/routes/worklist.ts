import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  assignments, dispatchableStudies, offerHistory, panelReaders, patients, slaClocks, studies,
} from '@telrad/db';
import {
  OFFER_ACCEPT_SECONDS, cleanText, newToken, pickReader, tzOffsetMinutes, type DispatchStudy,
} from '@telrad/shared';
import { Router } from 'express';
import { appendAudit } from '../audit.js';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx } from '../auth.js';

const READER_ROLES = ['radiologist', 'reviewer'];
const BOARD_ROLES = ['owner', 'console', 'radiologist', 'reviewer'];

// The reader's side of routing. A board that only shows colour tells an operator who
// is free; this is the half that turns that into "the case is on your desk", and it is
// the padlock the schema was designed around: an offer becomes a lock only when the
// reader themselves says so, and every way out of it writes a reason.
export function worklistRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/my', '/assignments', '/dispatch'], requireAuth(db)));

  // A live offer, an accepted case, or a read in progress — all of them are "mine
  // right now", and a reader holding two cases must be able to see both.
  r.get('/my/work', async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const userId = req.principal!.userId;
    const now = new Date();

    const rows = await db.select({
      assignmentId: assignments.id,
      state: assignments.state,
      offeredAt: assignments.offeredAt,
      acceptedAt: assignments.acceptedAt,
      attemptNo: assignments.attemptNo,
      studyId: studies.id,
      tenantId: studies.tenantId,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: studies.priority,
      studyDate: studies.studyDate,
      studyDescription: studies.studyDescription,
      receivedAt: studies.receivedAt,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      patientDob: patients.dob,
      waitingMinutes: sql<number>`round(extract(epoch from now() - ${studies.receivedAt}) / 60)::int`,
    }).from(assignments)
      .innerJoin(studies, eq(studies.id, assignments.studyId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .where(and(
        eq(assignments.clinicianUserId, userId),
        inArray(assignments.state, ['offered', 'accepted', 'reading']),
      ))
      .orderBy(
        sql`case ${studies.priority} when 'stat' then 0 when 'urgent' then 1 else 2 end`,
        assignments.offeredAt,
      );

    await appendAudit(db, {
      actorUserId: userId, actorKind: 'human', tenantId: req.principal!.tenantId,
      action: 'worklist.read', entity: 'assignments', detail: { count: rows.length },
    });

    // The lock token is deliberately absent from this list: it is issued once, at
    // acceptance, and a board that re-echoed it would make a screenshot a credential.
    res.json({
      ok: true,
      generatedAt: now,
      offerWindowSeconds: OFFER_ACCEPT_SECONDS,
      cases: rows.map((row) => ({
        ...row,
        expiresAt: row.state === 'offered'
          ? new Date(row.offeredAt.getTime() + OFFER_ACCEPT_SECONDS * 1000)
          : null,
      })),
    });
  });

  r.post('/assignments/:id/accept', async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });

    const now = new Date();
    // One conditional update rather than a read-then-write: two readers cannot both
    // turn the same offer into a lock, and the loser gets a 409 instead of quietly
    // overwriting whoever asked first.
    const [row] = await db.update(assignments)
      .set({ state: 'accepted', acceptedAt: now, lockToken: newToken(24) })
      .where(and(
        eq(assignments.id, id),
        eq(assignments.clinicianUserId, req.principal!.userId),
        eq(assignments.state, 'offered'),
      ))
      .returning({
        id: assignments.id,
        studyId: assignments.studyId,
        tenantId: assignments.tenantId,
        attemptNo: assignments.attemptNo,
        lockToken: assignments.lockToken,
      });

    if (!row) {
      const [found] = await db.select({ state: assignments.state, userId: assignments.clinicianUserId })
        .from(assignments).where(eq(assignments.id, id)).limit(1);
      // Another reader's assignment and a nonexistent one both answer 404, so an id
      // cannot be probed for existence across readers.
      if (!found || found.userId !== req.principal!.userId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      return res.status(409).json({ ok: false, error: 'not_offered', state: found.state });
    }

    const [study] = await db.select({ priority: studies.priority }).from(studies)
      .where(eq(studies.id, row.studyId)).limit(1);

    // The clock records when reading actually began, which is the number a contract
    // dispute turns on. Only the first acceptance writes it, so a case that was handed
    // back and re-accepted keeps the response time the center was first answered with.
    await db.update(slaClocks).set({ acceptedAt: now })
      .where(and(eq(slaClocks.studyId, row.studyId), sql`${slaClocks.acceptedAt} is null`));

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'assignment.accepted', entity: 'assignments', entityId: String(row.id),
      detail: { studyId: row.studyId, priority: study?.priority ?? null, attemptNo: row.attemptNo },
    });

    res.json({ ok: true, assignmentId: row.id, studyId: row.studyId, acceptedAt: now, lockToken: row.lockToken });
  });

  r.post('/assignments/:id/decline', async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const reason = cleanText(req.body?.reason, 200);
    if (!reason) {
      return res.status(422).json({ ok: false, error: 'a reason is required to hand a case back' });
    }

    const now = new Date();
    const [row] = await db.update(assignments)
      .set({ state: 'returned', returnedAt: now, returnReason: reason, lockToken: null })
      .where(and(
        eq(assignments.id, id),
        eq(assignments.clinicianUserId, req.principal!.userId),
        inArray(assignments.state, ['offered', 'accepted']),
      ))
      .returning({ id: assignments.id, studyId: assignments.studyId, tenantId: assignments.tenantId });

    if (!row) {
      const [existing] = await db.select({ state: assignments.state }).from(assignments)
        .where(and(eq(assignments.id, id), eq(assignments.clinicianUserId, req.principal!.userId)))
        .limit(1);
      if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });
      // 'reading' means a draft exists. Handing that back is a different operation from
      // declining, and the report path is not built, so this refuses rather than
      // silently discarding work in progress.
      return res.status(409).json({ ok: false, error: 'cannot_return', state: existing.state });
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'assignment.returned', entity: 'assignments', entityId: String(row.id),
      detail: { studyId: row.studyId, reason },
    });
    res.json({ ok: true, assignmentId: row.id, studyId: row.studyId, state: 'returned' });
  });

  // The operator's question when a case is sitting: not "is anything unassigned" but
  // "who was skipped, and for what reason". The answer is the dispatcher's own rule run
  // in read mode against the same two queries, so this cannot report a gap the sweep
  // does not have — or hide one it does.
  r.get('/dispatch/unassigned', async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const tenantId = scopeTenant(req.principal!);
    const now = new Date();
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    const queue = await dispatchableStudies(db, { limit, tenantId: tenantId ?? undefined });
    const tenantIds = [...new Set(queue.map((s) => s.tenantId))];
    const readers = tenantIds.length === 0 ? [] : await panelReaders(db, tenantIds, now);
    const prior = await offerHistory(db, queue.map((s) => s.id));

    const unassigned = queue.map((row) => {
      const study: DispatchStudy = {
        id: row.id,
        tenantId: row.tenantId,
        priority: row.priority,
        subSpecialtyCode: row.subSpecialtyCode,
        modalityCode: row.modalityCode,
        tenantTzOffsetMinutes: tzOffsetMinutes(row.tenantTimezone, now),
      };
      // Same rotation history the sweep uses, so this cannot promise the operator a
      // reader the dispatcher has already asked and lost.
      const decision = pickReader(study, readers, { now, alreadyOfferedTo: prior.get(row.id)?.userIds ?? [] });
      const closest = decision.considered[0];
      return {
        studyId: row.id,
        tenantId: row.tenantId,
        orderId: row.orderId,
        priority: row.priority,
        modality: row.modalityCode,
        subSpecialty: row.subSpecialtyCode,
        receivedAt: row.receivedAt,
        waitingMinutes: Math.round((now.getTime() - row.receivedAt.getTime()) / 60_000),
        // 'waiting_for_sweep' is the ordinary state: the sweep runs on the worker's
        // poll interval, so a case that routes cleanly stays unassigned for seconds.
        status: decision.chosenUserId !== null ? 'waiting_for_sweep' : 'blocked',
        wouldRouteTo: decision.chosenUserId,
        blockedBecause: decision.chosenUserId === null ? decision.reason : null,
        nearestReader: closest ? { userId: closest.userId, name: closest.name, missing: closest.rejectedFor } : null,
        panelSize: readers.length,
      };
    });

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'dispatch.unassigned_read', entity: 'studies', detail: { count: unassigned.length },
    });
    res.json({
      ok: true,
      generatedAt: now,
      counts: {
        unassigned: unassigned.length,
        blocked: unassigned.filter((u) => u.status === 'blocked').length,
        // Counted as spare slots, not as "routable": presence needs a heartbeat, and
        // this endpoint deliberately does not re-derive colour from a second read.
        readersWithCapacity: readers.filter((reader) => reader.openCases < reader.maxQueueSize).length,
      },
      unassigned,
    });
  });

  return r;
}
