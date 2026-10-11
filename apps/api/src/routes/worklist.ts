import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  assignments,
  clinicianProfiles,
  dispatchableStudies,
  escalationRules,
  offerHistory,
  panelReaders,
  patients,
  reports,
  slaClocks,
  studies,
  tenants,
  users,
} from '@telrad/db';
import {
  OFFER_ACCEPT_SECONDS, cleanText, coversCode, currentVersion, dueStages, elapsedPct, isBreached,
  newToken, pickReader, tzOffsetMinutes, widenStage,
  type ClockLike, type DispatchStudy, type EscalationRule, type ReportState,
} from '@telrad/shared';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const READER_ROLES = ['radiologist', 'reviewer'];
const BOARD_ROLES = ['owner', 'console', 'radiologist', 'reviewer'];

// The reader's side of routing. A board that only shows colour tells an operator who
// is free; this is the half that turns that into "the case is on your desk", and it is
// the padlock the schema was designed around: an offer becomes a lock only when the
// reader themselves says so, and every way out of it writes a reason.
export function worklistRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/my', '/assignments', '/dispatch', '/escalations'], requireAuth(db)));

  // A live offer, an accepted case, or a read in progress — all of them are "mine
  // right now", and a reader holding two cases must be able to see both.
  r.get('/my/work', ah(async (req: Ctx, res) => {
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

    // Whether a case already carries a report is the difference between "open this" and
    // "finish the draft you left at 03:00", and it is answered by the same currentVersion()
    // the report routes use, so a desk and a document cannot point at two different
    // versions of one study.
    const reportOfStudy = new Map<number, { id: number; version: number; state: ReportState }>();
    if (rows.length > 0) {
      const found = await db.select({
        id: reports.id,
        studyId: reports.studyId,
        version: reports.version,
        state: reports.state,
      }).from(reports).where(inArray(reports.studyId, rows.map((row) => row.studyId)));
      for (const row of rows) {
        const hit = currentVersion(found.filter((f) => f.studyId === row.studyId));
        if (hit) reportOfStudy.set(row.studyId, { id: hit.id, version: hit.version, state: hit.state });
      }
    }

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
        report: reportOfStudy.get(row.studyId) ?? null,
      })),
    });
  }));

  r.post('/assignments/:id/accept', ah(async (req: Ctx, res) => {
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
  }));

  r.post('/assignments/:id/decline', ah(async (req: Ctx, res) => {
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
  }));

  // The operator's question when a case is sitting: not "is anything unassigned" but
  // "who was skipped, and for what reason". The answer is the dispatcher's own rule run
  // in read mode against the same two queries, so this cannot report a gap the sweep
  // does not have — or hide one it does.
  r.get('/dispatch/unassigned', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const tenantId = scopeTenant(req.principal!);
    const now = new Date();
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    const queue = await dispatchableStudies(db, { limit, tenantId: tenantId ?? undefined });
    const tenantIds = [...new Set(queue.map((s) => s.tenantId))];
    const readers = tenantIds.length === 0 ? [] : await panelReaders(db, tenantIds, now);
    const prior = await offerHistory(db, queue.map((s) => s.id));
    const rules = (await db.select({
      tenantId: escalationRules.tenantId, priority: escalationRules.priority, stage: escalationRules.stage,
      atElapsedPct: escalationRules.atElapsedPct, action: escalationRules.action,
    }).from(escalationRules).where(eq(escalationRules.enabled, true)))
      .map((row) => ({ ...row, action: row.action as EscalationRule['action'] }));

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
      const widenAt = widenStage(rules, row.tenantId, row.priority);
      const poolWidened = widenAt !== null && row.escalationStage >= widenAt;
      const decision = pickReader(study, readers, {
        now, alreadyOfferedTo: prior.get(row.id)?.userIds ?? [], allowAtCap: poolWidened,
      });
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
        escalationStage: row.escalationStage,
        deadlineAt: row.deadlineAt,
        elapsedPct: row.deadlineAt ? elapsedPct({ startedAt: row.receivedAt, deadlineAt: row.deadlineAt }, now) : null,
        // Reported because a widened offer is the one routing decision a reader would
        // want to know was made under time pressure rather than by choice.
        poolWidened,
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
  }));

  // A person, not the router. When widening the pool still leaves a case unassigned, an
  // operator puts it on somebody's desk and says why. This overrides *routability* only:
  // coverage may be passed over because a named human is taking responsibility for that
  // decision, and the mismatch is reported back and audited rather than quietly
  // normalised away.
  r.post('/assignments', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return undefined;
    const studyId = Number(req.body?.studyId);
    const clinicianUserId = Number(req.body?.clinicianUserId);
    const reason = cleanText(req.body?.reason, 200);
    if (!Number.isInteger(studyId) || !Number.isInteger(clinicianUserId)) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }
    if (!reason) return res.status(422).json({ ok: false, error: 'a reason is required for a manual assignment' });

    const [study] = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      linkState: studies.linkState,
      subSpecialtyCode: studies.subSpecialtyCode,
      modalityCode: studies.modalityCode,
      accession: studies.accessionNumber,
    }).from(studies).where(eq(studies.id, studyId)).limit(1);
    if (!study) return res.status(404).json({ ok: false, error: 'not_found' });
    if (study.linkState !== 'linked' || study.tenantId === null) {
      return res.status(422).json({ ok: false, error: 'only a linked study with a tenant can be assigned' });
    }

    const [reader] = await db.select({
      userId: users.id,
      name: users.displayName,
      role: users.role,
      status: users.status,
      subspecialtyCodes: clinicianProfiles.subspecialtyCodes,
      modalityCodes: clinicianProfiles.modalityCodes,
    }).from(users)
      .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, users.id))
      .where(eq(users.id, clinicianUserId))
      .limit(1);
    if (!reader || !READER_ROLES.includes(reader.role) || reader.status !== 'active') {
      // 404 rather than "that account is not a reader": probing ids from a console
      // session should not enumerate who else has an account.
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const now = new Date();
    const prior = await offerHistory(db, [studyId]);
    const [created] = await db.insert(assignments)
      .values({
        studyId,
        tenantId: study.tenantId,
        clinicianUserId: reader.userId,
        state: 'accepted',
        offeredAt: now,
        acceptedAt: now,
        attemptNo: (prior.get(studyId)?.maxAttempt ?? 0) + 1,
        escalatedBy: req.principal!.userId,
        // Minted and deliberately not echoed: nothing consumes a lock token until the
        // report path exists, and returning one here would put a clinical credential in
        // an operator's response history.
        lockToken: newToken(24),
      })
      .onConflictDoNothing()
      .returning({ id: assignments.id, studyId: assignments.studyId });
    if (!created) return res.status(409).json({ ok: false, error: 'already_assigned' });

    await db.update(slaClocks).set({ acceptedAt: now })
      .where(and(eq(slaClocks.studyId, studyId), isNull(slaClocks.acceptedAt)));

    const notListed: string[] = [];
    if (study.subSpecialtyCode && !coversCode(reader.subspecialtyCodes, study.subSpecialtyCode)) {
      notListed.push(`sub-specialty ${study.subSpecialtyCode}`);
    }
    if (study.modalityCode && !coversCode(reader.modalityCodes, study.modalityCode)) {
      notListed.push(`modality ${study.modalityCode}`);
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: study.tenantId,
      action: 'assignment.manual', entity: 'assignments', entityId: String(created.id),
      detail: {
        studyId, accession: study.accession, clinicianUserId: reader.userId, reason, coverageNotListed: notListed,
      },
    });
    res.status(201).json({
      ok: true,
      assignmentId: created.id,
      studyId,
      clinicianUserId: reader.userId,
      heldBy: reader.name,
      warning: notListed.length > 0 ? `${reader.name} does not list ${notListed.join(' or ')}` : null,
    });
  }));

  // The late board: not "what is unassigned" but "what is running out, who holds it, and
  // has the system said anything yet". The stage arithmetic is the worker's own rule, so
  // the board cannot show a case as calm while the sweep is escalating it.
  r.get('/escalations', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const tenantId = scopeTenant(req.principal!);
    const now = new Date();
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 300);

    const clocks = await db.select({
      clockId: slaClocks.id,
      studyId: slaClocks.studyId,
      tenantId: slaClocks.tenantId,
      tenantCode: tenants.code,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: slaClocks.priority,
      startedAt: studies.receivedAt,
      deadlineAt: slaClocks.deadlineAt,
      stage: slaClocks.escalationStage,
      lastEscalatedAt: slaClocks.lastEscalatedAt,
      breached: slaClocks.breached,
      breachedAt: slaClocks.breachedAt,
      signedAt: slaClocks.signedAt,
      acceptedAt: slaClocks.acceptedAt,
    }).from(slaClocks)
      .innerJoin(studies, eq(studies.id, slaClocks.studyId))
      .leftJoin(tenants, eq(tenants.id, slaClocks.tenantId))
      .where(and(
        isNull(slaClocks.deliveredAt),
        tenantId === null ? undefined : eq(slaClocks.tenantId, tenantId),
      ))
      .orderBy(slaClocks.deadlineAt)
      .limit(limit);

    const held = clocks.length === 0 ? [] : await db.select({
      studyId: assignments.studyId,
      userId: assignments.clinicianUserId,
      name: users.displayName,
      state: assignments.state,
    }).from(assignments)
      .innerJoin(users, eq(users.id, assignments.clinicianUserId))
      .where(and(
        inArray(assignments.studyId, clocks.map((c) => c.studyId)),
        inArray(assignments.state, ['offered', 'accepted', 'reading']),
      ));
    const holderOf = new Map(held.map((h) => [h.studyId, h]));

    const rules = (await db.select({
      tenantId: escalationRules.tenantId,
      priority: escalationRules.priority,
      stage: escalationRules.stage,
      atElapsedPct: escalationRules.atElapsedPct,
      action: escalationRules.action,
    }).from(escalationRules).where(eq(escalationRules.enabled, true)))
      .map((row) => ({ ...row, action: row.action as EscalationRule['action'] }));

    // Signed reports waiting for a second name. These are not on the SLA clock — the
    // contract was answered at signature — but a report that has sat unreviewed for hours
    // is an operational gap the reviewer queue does not surface to the operator. The sweep
    // writes audit rows; this query shows the live state so the board can name them.
    const reviewWaiting = await db.select({
      reportId: reports.id,
      studyId: reports.studyId,
      tenantId: reports.tenantId,
      tenantCode: tenants.code,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      signedAt: reports.signedAt,
      authorName: reports.authorName,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .where(and(
        eq(reports.state, 'signed'),
        isNull(reports.reviewerUserId),
        tenantId === null ? undefined : eq(reports.tenantId, tenantId),
      ))
      .orderBy(reports.signedAt)
      .limit(50);

    // "Late" means the sweep would say something about it: a stage already fired, a
    // deadline passed, or a stage due on the next pass. A calm clock is not on this board.
    // ClockLike is the shape the shared rule measures; the board's rows carry a few more
    // columns for display, so they are adapted rather than assumed compatible.
    const asClock = (c: typeof clocks[number]): ClockLike => ({
      id: c.clockId, studyId: c.studyId, tenantId: c.tenantId, priority: c.priority,
      startedAt: c.startedAt, deadlineAt: c.deadlineAt, stage: c.stage, signedAt: c.signedAt,
    });
    const late = clocks.filter((c) => c.stage > 0 || c.breached || isBreached(asClock(c), now)
      || dueStages(asClock(c), rules, now).length > 0);

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'escalations.read', entity: 'sla_clocks', detail: { open: clocks.length },
    });
    res.json({
      ok: true, generatedAt: now,
      counts: {
        open: clocks.length,
        late: late.length,
        breached: late.filter((c) => c.breached || isBreached(asClock(c), now)).length,
        unheld: late.filter((c) => !holderOf.has(c.studyId)).length,
        reviewWaiting: reviewWaiting.length,
      },
      late: late.map((c) => ({
        clockId: c.clockId,
        studyId: c.studyId,
        tenant: c.tenantCode,
        accession: c.accession,
        modality: c.modality,
        subSpecialty: c.subSpecialty,
        priority: c.priority,
        deadlineAt: c.deadlineAt,
        minutesToDeadline: Math.round((c.deadlineAt.getTime() - now.getTime()) / 60_000),
        elapsedPct: elapsedPct(asClock(c), now),
        stage: c.stage,
        lastEscalatedAt: c.lastEscalatedAt,
        breached: c.breached || isBreached(asClock(c), now),
        holder: holderOf.get(c.studyId) ?? null,
      })),
      reviewWaiting: reviewWaiting.map((r) => ({
        reportId: r.reportId,
        studyId: r.studyId,
        tenant: r.tenantCode,
        accession: r.accession,
        modality: r.modality,
        subSpecialty: r.subSpecialty,
        signedAt: r.signedAt,
        authorName: r.authorName,
        waitingMinutes: r.signedAt ? Math.round((now.getTime() - r.signedAt.getTime()) / 60_000) : null,
      })),
    });
  }));

  return r;
}
