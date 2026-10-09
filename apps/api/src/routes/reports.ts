import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type Db, appendAudit, assignments, clinicianProfiles, patients, reports, slaClocks,
  studies, subSpecialties, tenants, users, type Report,
} from '@telrad/db';
import {
  REPORT_SECTIONS, type Grade, amendDecision, countersignDecision, currentVersion,
  mayReadReport, missingSections, nextVersion, signDecision, stateAllows,
} from '@telrad/shared';
import { Router, type Response } from 'express';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx, type Principal } from '../auth.js';
import { ah } from '../handler.js';

const READER_ROLES = ['radiologist', 'reviewer'];
// A report body is not a novel. The cap exists because this text goes into a jsonb column
// that a center will one day render as a PDF, and an unbounded field is how one pasted
// dictionary ends up copied into every version of a patient's report.
const MAX_SECTION_CHARS = 20_000;

// An offer is not a desk. The viewer lets a reader look at a case they have only been
// offered — refusing that would force them to accept blind — but a report is the opposite
// act: it commits the tenant to a signed document with a name on it, so it requires the
// reader to have said yes first.
const HOLD_STATES: ('accepted' | 'reading')[] = ['accepted', 'reading'];

type ReportView = Report & {
  accession: string | null;
  modality: string | null;
  subSpecialty: string | null;
  priority: string | null;
  studyDate: string | null;
  tenantCode: string | null;
  requiresReviewer: boolean;
  patientName: string | null;
  patientMrn: string | null;
  patientDob: Date | null;
  patientGender: string | null;
};

/**
 * Drafting, signing, clearing and amending reports. The rules live in
 * `@telrad/shared/src/report.ts` because the browser has to grey out the same buttons the
 * server refuses; this file is I/O, authorization and the audit trail.
 */
export function reportsRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/reports'], requireAuth(db)));

  async function profileOf(userId: number) {
    const [row] = await db.select({
      userId: clinicianProfiles.userId,
      grade: clinicianProfiles.grade,
      registration: clinicianProfiles.registrationNumber,
      council: clinicianProfiles.registrationCouncil,
      displayName: users.displayName,
    }).from(clinicianProfiles)
      .innerJoin(users, eq(users.id, clinicianProfiles.userId))
      .where(eq(clinicianProfiles.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async function loadReport(id: number): Promise<ReportView | null> {
    const [row] = await db.select({
      r: reports,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: studies.priority,
      studyDate: studies.studyDate,
      requiresReviewer: subSpecialties.requiresReviewer,
      tenantCode: tenants.code,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      patientDob: patients.dob,
      patientGender: patients.gender,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .leftJoin(subSpecialties, eq(subSpecialties.code, studies.subSpecialtyCode))
      .where(eq(reports.id, id))
      .limit(1);
    if (!row) return null;
    return {
      ...row.r,
      accession: row.accession,
      modality: row.modality,
      subSpecialty: row.subSpecialty,
      priority: row.priority,
      studyDate: row.studyDate,
      tenantCode: row.tenantCode,
      requiresReviewer: row.requiresReviewer ?? false,
      patientName: row.patientName,
      patientMrn: row.patientMrn,
      patientDob: row.patientDob,
      patientGender: row.patientGender,
    };
  }

  /**
   * Reading a report is a wider permission than reading its pixels, and the rule lives in
   * `@telrad/shared` so the same answer can be tested without a database. What this route
   * adds is the tenant wall in front of it.
   */
  function mayRead(row: ReportView, p: Principal): boolean {
    return mayReadReport({
      state: row.state, authorUserId: row.authorUserId, readerUserId: p.userId, readerRole: p.role,
    });
  }

  async function denied(
    res: Response, p: Principal, entityId: string, cross: boolean,
  ): Promise<Response> {
    if (cross) {
      // Recorded against the *actor's* tenant: the question an operator asks is why one of
      // my readers was poking at another center's ids.
      await appendAudit(db, {
        actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
        action: 'report.denied_cross_tenant', entity: 'reports', entityId,
      });
    }
    // 404 in both directions, so neither an id's existence nor the existence of an
    // unfinished draft is ever confirmed.
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  async function versionsOf(studyId: number) {
    return await db.select({
      id: reports.id,
      version: reports.version,
      state: reports.state,
      authorName: reports.authorName,
      signedAt: reports.signedAt,
      verifiedAt: reports.verifiedAt,
    }).from(reports).where(eq(reports.studyId, studyId)).orderBy(desc(reports.version));
  }

  /** The one version a study should be answered with, or null when all are history. */
  async function liveOf(studyId: number): Promise<ReportView | null> {
    const rows = await db.select({ version: reports.version, state: reports.state, id: reports.id })
      .from(reports).where(eq(reports.studyId, studyId));
    const hit = currentVersion(rows);
    return hit ? await loadReport(hit.id) : null;
  }

  function describeReport(
    row: ReportView,
    history: Awaited<ReturnType<typeof versionsOf>>,
    me: { userId: number; grade: Grade | null } | null,
    authorGrade: Grade | null,
  ) {
    const mine = me !== null && row.authorUserId === me.userId;
    return {
      id: row.id,
      studyId: row.studyId,
      version: row.version,
      state: row.state,
      sections: row.sections,
      author: { userId: row.authorUserId, name: row.authorName, registration: row.authorRegistration },
      reviewer: row.reviewerUserId === null ? null : {
        userId: row.reviewerUserId, name: row.reviewerName, registration: row.reviewerRegistration,
      },
      signedAt: row.signedAt,
      verifiedAt: row.verifiedAt,
      deliveredAt: row.deliveredAt,
      supersedesReportId: row.supersedesReportId,
      // The version number rather than the row id, because it is the version a reader
      // reads in the sentence "correction to v1". Derived from the history the same
      // response carries, so it cannot drift from what is on screen.
      supersedesVersion: row.supersedesReportId === null ? null
        : (history.find((h) => h.id === row.supersedesReportId)?.version ?? null),
      amendmentReason: row.amendmentReason,
      createdAt: row.createdAt,
      gaps: missingSections(row.sections),
      // Computed for the caller, not for the document. A generic "this state allows a
      // countersignature" would light up the button on the author's own screen, where the
      // server is obliged to answer `self_review`, and a reader who has just signed a
      // report should not be invited to review themselves.
      can: {
        edit: mine && stateAllows('edit', row.state),
        sign: mine && stateAllows('sign', row.state),
        withdraw: mine && stateAllows('withdraw', row.state),
        countersign: countersignDecision({
          state: row.state,
          authorUserId: row.authorUserId,
          reviewerUserId: me?.userId ?? 0,
          authorGrade,
          reviewerGrade: me?.grade ?? null,
        }).ok,
        // The reason is what the amender is about to type, so it is present-and-non-blank
        // by construction here; the state and the two grades are what can be settled now.
        amend: amendDecision({
          state: row.state,
          reason: 'pending',
          authorGrade,
          amenderGrade: me?.grade ?? null,
        }).ok,
      },
      history,
      study: {
        accession: row.accession,
        modality: row.modality,
        subSpecialty: row.subSpecialty,
        priority: row.priority,
        studyDate: row.studyDate,
        tenantCode: row.tenantCode,
        requiresReviewer: row.requiresReviewer,
      },
      patient: { name: row.patientName, mrn: row.patientMrn, dob: row.patientDob, gender: row.patientGender },
    };
  }

  async function respond(res: Response, p: Principal, reportId: number, status = 200) {
    const row = await loadReport(reportId);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const [me, author] = await Promise.all([profileOf(p.userId), profileOf(row.authorUserId)]);
    return res.status(status).json({
      ok: true,
      report: describeReport(row, await versionsOf(row.studyId),
        me ? { userId: p.userId, grade: me.grade } : { userId: p.userId, grade: null },
        author?.grade ?? null),
    });
  }

  // Also before '/reports/:id'. This is the author's way back into a case: signing
  // completes the read, which takes the study off the desk that led to it, and a reader who
  // wants to check what they said on Tuesday would otherwise have no link to follow.
  r.get('/reports/mine', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const p = req.principal!;
    const rows = await db.select({
      reportId: reports.id,
      studyId: reports.studyId,
      version: reports.version,
      state: reports.state,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      patientName: patients.fullName,
      signedAt: reports.signedAt,
      verifiedAt: reports.verifiedAt,
      reviewerName: reports.reviewerName,
      amendmentReason: reports.amendmentReason,
      tenantCode: tenants.code,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .where(eq(reports.authorUserId, p.userId))
      .orderBy(desc(reports.createdAt))
      .limit(25);

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'report.mine', entity: 'reports', detail: { count: rows.length },
    });
    res.json({ ok: true, generatedAt: new Date(), reports: rows });
  }));

  // Declared before '/reports/:id' deliberately: an Express pattern would otherwise swallow
  // this word as an id and answer 400 for the one path that lists real work.
  r.get('/reports/awaiting-review', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const p = req.principal!;
    const me = await profileOf(p.userId);
    const scope = scopeTenant(p);

    const rows = await db.select({
      reportId: reports.id,
      studyId: reports.studyId,
      version: reports.version,
      authorUserId: reports.authorUserId,
      authorName: reports.authorName,
      authorGrade: clinicianProfiles.grade,
      signedAt: reports.signedAt,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      requiresReviewer: subSpecialties.requiresReviewer,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(clinicianProfiles, eq(clinicianProfiles.userId, reports.authorUserId))
      .leftJoin(subSpecialties, eq(subSpecialties.code, studies.subSpecialtyCode))
      .where(and(
        scope === null ? sql`true` : eq(reports.tenantId, scope),
        eq(reports.state, 'signed'),
        ne(reports.authorUserId, p.userId),
      ))
      .orderBy(desc(reports.signedAt));

    // The grade test is per row and the reviewer's own grade may be missing, so it is
    // computed here rather than in SQL: a junior must still see the queue, and see plainly
    // which entries they cannot clear.
    const out = rows.map((row) => {
      const decision = countersignDecision({
        state: 'signed',
        authorUserId: row.authorUserId,
        reviewerUserId: p.userId,
        authorGrade: row.authorGrade,
        reviewerGrade: me?.grade ?? null,
      });
      return {
        ...row,
        mayClear: decision.ok,
        reason: decision.ok ? null : decision.reason,
      };
    });

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'report.review_queue', entity: 'reports', detail: { count: out.length },
    });
    res.json({ ok: true, generatedAt: new Date(), myGrade: me?.grade ?? null, awaiting: out });
  }));

  r.get('/reports/current', ah(async (req: Ctx, res) => {
    const studyId = Number(req.query.studyId);
    if (!Number.isInteger(studyId)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await liveOf(studyId);
    if (!row) return res.status(404).json({ ok: false, error: 'no_report' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(row.id), true);
    if (!mayRead(row, p)) return await denied(res, p, String(row.id), false);
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.read', entity: 'reports', entityId: String(row.id),
      detail: { studyId, version: row.version, state: row.state },
    });
    return respond(res, p, row.id);
  }));

  r.get('/reports/:id', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);
    if (!mayRead(row, p)) return await denied(res, p, String(id), false);
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.read', entity: 'reports', entityId: String(id),
      detail: { studyId: row.studyId, version: row.version, state: row.state },
    });
    return respond(res, p, id);
  }));

  r.post('/reports', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const p = req.principal!;
    const studyId = Number(req.body?.studyId);
    if (!Number.isInteger(studyId)) return res.status(400).json({ ok: false, error: 'bad_id' });

    const [study] = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      accession: studies.accessionNumber,
      subSpecialty: studies.subSpecialtyCode,
    }).from(studies).where(eq(studies.id, studyId)).limit(1);
    if (!study || study.tenantId === null) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && study.tenantId !== scope) return await denied(res, p, String(studyId), true);

    const [held] = await db.select({ id: assignments.id }).from(assignments)
      .where(and(
        eq(assignments.studyId, studyId),
        eq(assignments.clinicianUserId, p.userId),
        inArray(assignments.state, HOLD_STATES),
      )).limit(1);
    if (!held) return res.status(403).json({ ok: false, error: 'not_your_case' });

    // Fail before the reader types anything: the signature columns are NOT NULL, so a
    // profile with no registration number cannot produce a report at all, and the wrong
    // moment to discover that is after a full set of findings.
    const me = await profileOf(p.userId);
    if (!me) return res.status(409).json({ ok: false, error: 'no_clinician_profile' });

    const existing = await liveOf(studyId);
    if (existing) {
      return res.status(409).json({
        ok: false, error: 'report_exists', reportId: existing.id, state: existing.state,
      });
    }

    // Not always 1. A withdrawn first draft keeps its row forever — that is the point of
    // closing rather than deleting — and the unique index on (study_id, version) would
    // otherwise reject the second attempt at reporting this study.
    const seen = await db.select({ version: reports.version }).from(reports)
      .where(eq(reports.studyId, studyId));
    const [row] = await db.insert(reports).values({
      studyId, tenantId: study.tenantId, version: nextVersion(seen.map((v) => v.version)),
      state: 'draft',
      authorUserId: p.userId, sections: {},
      authorName: me.displayName, authorRegistration: me.registration,
    }).returning();

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: study.tenantId,
      action: 'report.draft_created', entity: 'reports', entityId: String(row!.id),
      detail: { studyId, accession: study.accession, version: row!.version },
    });
    return respond(res, p, row!.id, 201);
  }));

  /**
   * Explicit save, called by a button. There is no autosave on this path: a draft that
   * writes itself on every keystroke makes "the document as it was when I signed it" a
   * moving target, and the audit row would describe text nobody had finished. The browser
   * holds unsaved words and says so in its own voice.
   */
  r.patch('/reports/:id', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.authorUserId !== p.userId) return res.status(403).json({ ok: false, error: 'not_the_author' });
    if (!stateAllows('edit', row.state)) {
      return res.status(409).json({ ok: false, error: 'signed_report_is_immutable', state: row.state });
    }

    const incoming = req.body?.sections;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: 'sections_required' });
    }
    const merged = { ...row.sections } as Record<string, string>;
    const changed: string[] = [];
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (!(REPORT_SECTIONS as readonly string[]).includes(key)) {
        // Refused rather than dropped: a client that sent `impressionn` would otherwise
        // believe it had written an impression.
        return res.status(400).json({ ok: false, error: 'unknown_section', section: key });
      }
      if (typeof value !== 'string') return res.status(400).json({ ok: false, error: 'section_not_text', section: key });
      if (value.length > MAX_SECTION_CHARS) return res.status(413).json({ ok: false, error: 'section_too_long', section: key });
      merged[key] = value;
      changed.push(key);
    }

    await db.update(reports).set({ sections: merged }).where(eq(reports.id, id));
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.draft_saved', entity: 'reports', entityId: String(id),
      // Which fields, and how long each one now is: the audit question after a dispute is
      // what the document said, and a hash of a jsonb blob does not answer it.
      detail: {
        studyId: row.studyId,
        version: row.version,
        changed,
        lengths: Object.fromEntries(
          REPORT_SECTIONS.map((s) => [s, (merged[s] ?? '').length] as const),
        ),
      },
    });
    return respond(res, p, id);
  }));

  r.post('/reports/:id/sign', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.authorUserId !== p.userId) return res.status(403).json({ ok: false, error: 'not_the_author' });

    const decision = signDecision({ state: row.state, sections: row.sections });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    const me = await profileOf(p.userId);
    if (!me) return res.status(409).json({ ok: false, error: 'no_clinician_profile' });

    const now = new Date();
    // Conditional on the state rather than read-then-write: two tabs on one draft must
    // produce one signature, and the loser gets 409 naming the state that won.
    const [signed] = await db.update(reports)
      .set({
        state: 'signed',
        signedAt: now,
        // Re-snapshotted at the moment of signing, so the block that prints under the text
        // is the registration the reader held then, not the one at first keystroke.
        authorName: me.displayName,
        authorRegistration: me.registration,
      })
      .where(and(eq(reports.id, id), eq(reports.state, 'draft')))
      .returning({ id: reports.id });
    if (!signed) return res.status(409).json({ ok: false, error: 'not_a_draft' });

    // The clock stops here, not at countersignature: the contract term with a center is the
    // time to a *signed* report. `dueStages` reads exactly this column, so writing it is
    // also what makes the escalation sweep leave the case alone from the next pass.
    await db.update(slaClocks).set({ signedAt: now })
      .where(and(eq(slaClocks.studyId, row.studyId), isNull(slaClocks.signedAt)));

    // Signing finishes the read. Left in `accepted`, the case would keep counting against
    // max_queue_size after the report was signed, and that reader would quietly stop
    // receiving work while looking at-capacity to the dispatcher.
    await db.update(assignments).set({ state: 'completed' })
      .where(and(
        eq(assignments.studyId, row.studyId),
        eq(assignments.clinicianUserId, p.userId),
        inArray(assignments.state, ['accepted', 'reading']),
      ));

    const [clock] = await db.select({ deadlineAt: slaClocks.deadlineAt })
      .from(slaClocks).where(eq(slaClocks.studyId, row.studyId)).limit(1);

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.signed', entity: 'reports', entityId: String(id),
      detail: {
        studyId: row.studyId,
        version: row.version,
        registration: me.registration,
        // Kept in the row rather than derived later: whether this signature landed inside
        // the contracted window is a fact about the moment it was written.
        late: clock ? now.getTime() > clock.deadlineAt.getTime() : null,
      },
    });
    return respond(res, p, id);
  }));

  r.post('/reports/:id/countersign', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);

    const author = await profileOf(row.authorUserId);
    const me = await profileOf(p.userId);
    const decision = countersignDecision({
      state: row.state,
      authorUserId: row.authorUserId,
      reviewerUserId: p.userId,
      authorGrade: author?.grade ?? null,
      reviewerGrade: me?.grade ?? null,
    });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    const now = new Date();
    const [verified] = await db.update(reports)
      .set({
        state: 'verified',
        verifiedAt: now,
        reviewerUserId: p.userId,
        reviewerName: me!.displayName,
        reviewerRegistration: me!.registration,
      })
      .where(and(eq(reports.id, id), eq(reports.state, 'signed'), isNull(reports.reviewerUserId)))
      .returning({ id: reports.id });
    if (!verified) return res.status(409).json({ ok: false, error: 'not_signed' });

    await db.update(slaClocks).set({ verifiedAt: now })
      .where(and(eq(slaClocks.studyId, row.studyId), isNull(slaClocks.verifiedAt)));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.countersigned', entity: 'reports', entityId: String(id),
      detail: {
        studyId: row.studyId,
        version: row.version,
        authorUserId: row.authorUserId,
        authorGrade: author?.grade ?? null,
        reviewerGrade: me!.grade,
        registration: me!.registration,
      },
    });
    return respond(res, p, id);
  }));

  r.post('/reports/:id/amend', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : null;
    const author = await profileOf(row.authorUserId);
    const me = await profileOf(p.userId);
    if (!me) return res.status(409).json({ ok: false, error: 'no_clinician_profile' });
    const decision = amendDecision({
      state: row.state,
      reason,
      authorGrade: author?.grade ?? null,
      amenderGrade: me.grade,
    });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    const seen = await db.select({ version: reports.version }).from(reports)
      .where(eq(reports.studyId, row.studyId));
    const version = nextVersion(seen.map((v) => v.version));

    // The old row keeps both names and both timestamps and only changes state, so "who
    // signed what on 14 March" stays answerable from data after the correction.
    await db.update(reports).set({ state: 'amended' }).where(eq(reports.id, id));

    const [next] = await db.insert(reports).values({
      studyId: row.studyId,
      tenantId: row.tenantId,
      version,
      state: 'draft',
      authorUserId: p.userId,
      // Copied, not blank: an amendment corrects the words that are already there, and
      // starting from an empty document is how a correction loses the findings it was
      // written against.
      sections: row.sections,
      authorName: me.displayName,
      authorRegistration: me.registration,
      supersedesReportId: id,
      amendmentReason: reason,
    }).returning({ id: reports.id });

    // Deliberately no write to sla_clocks. The center was answered on time by the first
    // signature; reopening the clock would turn a correction into a breach the dispatcher
    // starts widening a pool for, and the deadline is about the answer, not about every
    // later amendment to it.
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.amended', entity: 'reports', entityId: String(next!.id),
      detail: {
        studyId: row.studyId,
        supersedesReportId: id,
        fromVersion: row.version,
        toVersion: version,
        reason,
        authorGrade: author?.grade ?? null,
        amenderGrade: me.grade,
      },
    });
    return respond(res, p, next!.id, 201);
  }));

  r.post('/reports/:id/withdraw', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.authorUserId !== p.userId) return res.status(403).json({ ok: false, error: 'not_the_author' });
    if (!stateAllows('withdraw', row.state)) return res.status(409).json({ ok: false, error: 'not_a_draft' });

    const [closed] = await db.update(reports).set({ state: 'withdrawn' })
      .where(and(eq(reports.id, id), eq(reports.state, 'draft')))
      .returning({ id: reports.id });
    if (!closed) return res.status(409).json({ ok: false, error: 'not_a_draft' });

    // The row survives. A draft that ceases to exist answers nothing when a patient later
    // asks who saw their study.
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.withdrawn', entity: 'reports', entityId: String(id),
      detail: { studyId: row.studyId, version: row.version, reason: req.body?.reason ?? null },
    });
    return respond(res, p, id);
  }));

  return r;
}
