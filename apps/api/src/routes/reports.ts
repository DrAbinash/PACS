import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type Db, appendAudit, assignments, clinicianProfiles, orders, patients, reports,
  reportDeliveries, reportRatings, slaClocks, studies, subSpecialties, tenants, users, type Report,
} from '@telrad/db';
import {
  REPORT_SECTIONS, type Grade, amendDecision, countersignDecision, currentVersion,
  deliverDecision, deliveryIdempotencyKey, mayReadReport, missingSections, needsSecondName,
  nextVersion, normalisePhone, signDecision, stateAllows,
} from '@telrad/shared';
import { Router, type Response } from 'express';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx, type Principal } from '../auth.js';
import {
  criticalsForStudy, describeCritical, openCriticalCounts, type DescribedCritical,
} from '../criticals-reads.js';
import { ah } from '../handler.js';
import { renderReportPdf, reportPdfFilename, type ReportPdfInput } from '../report-pdf.js';

const READER_ROLES = ['radiologist', 'reviewer'];
// Releasing a report to the referring clinic is a desk act, not a reading act. The reader
// who signed it has already put their name on the words; whether the document leaves now is
// the center's operational decision, and keeping it that way means an overdue case cannot
// be pushed out the door by the one person under time pressure to do it.
const DESK_ROLES = ['center_staff', 'owner', 'console'];
// Which states have a document. A draft has none — the screen shows the words, and a PDF of
// an unsigned report is a thing people forward. A superseded version keeps one, because the
// question "what did you send us in March" has to be answerable after the amendment.
const DOWNLOADABLE: readonly string[] = ['signed', 'verified', 'delivered', 'amended'];
// The two states delivery accepts, and the conditional the update is guarded by — a
// concurrent release from a second desk tab loses here rather than writing a second audit
// row for a document that went out once.
const DELIVER_STATES: ('signed' | 'verified')[] = ['signed', 'verified'];
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
  receivedAt: Date | null;
  tenantCode: string | null;
  centreName: string | null;
  requiresReviewer: boolean;
  referringName: string | null;
  referringRegistration: string | null;
  referringPhone: string | null;
  referringEmail: string | null;
  patientName: string | null;
  patientMrn: string | null;
  patientDob: Date | null;
  patientAge: string | null;
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
      receivedAt: studies.receivedAt,
      requiresReviewer: subSpecialties.requiresReviewer,
      tenantCode: tenants.code,
      centreName: tenants.legalName,
      referringName: orders.referringName,
      referringRegistration: orders.referringRegistration,
      referringPhone: orders.referringPhone,
      referringEmail: orders.referringEmail,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      patientDob: patients.dob,
      patientAge: patients.ageText,
      patientGender: patients.gender,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .leftJoin(orders, eq(orders.id, studies.orderId))
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
      receivedAt: row.receivedAt,
      tenantCode: row.tenantCode,
      centreName: row.centreName,
      requiresReviewer: row.requiresReviewer ?? false,
      referringName: row.referringName,
      referringRegistration: row.referringRegistration,
      referringPhone: row.referringPhone,
      referringEmail: row.referringEmail,
      patientName: row.patientName,
      patientMrn: row.patientMrn,
      patientDob: row.patientDob,
      patientAge: row.patientAge,
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
      // Read out with the history because the chain only points backwards: v2 knows it
      // supersedes v1, and v1 has no column that names v2. Anything that has to say
      // "this version was replaced by v2" — the screen's history list and the banner on a
      // superseded PDF — answers from this column rather than from a second query.
      supersedesReportId: reports.supersedesReportId,
      authorName: reports.authorName,
      signedAt: reports.signedAt,
      verifiedAt: reports.verifiedAt,
    }).from(reports).where(eq(reports.studyId, studyId)).orderBy(desc(reports.version));
  }

  const versionOf = (
    history: Awaited<ReturnType<typeof versionsOf>>, reportId: number | null,
  ): number | null =>
    reportId === null ? null : history.find((h) => h.id === reportId)?.version ?? null;

  const supersededByOf = (
    history: Awaited<ReturnType<typeof versionsOf>>, reportId: number,
  ): number | null =>
    history.find((h) => h.supersedesReportId === reportId)?.version ?? null;

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
    me: { userId: number; role: string; grade: Grade | null } | null,
    authorGrade: Grade | null,
    criticals: DescribedCritical[],
    outbox: Awaited<ReturnType<typeof outboxOf>>,
  ) {
    const mine = me !== null && row.authorUserId === me.userId;
    // Counted from the loops still open on this study, which is what the delivery rule asks
    // for: an acknowledged finding stops gating, and one nobody has answered does not stop
    // gating because the report describing it was corrected.
    const openCriticals = criticals.filter((c) => c.acknowledgedAt === null).length;
    const deliverable = deliverDecision({
      state: row.state,
      requiresReviewer: row.requiresReviewer,
      hasReviewer: row.reviewerUserId !== null,
      openCriticals,
    });
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
      supersedesVersion: versionOf(history, row.supersedesReportId),
      // The other direction, which no column on this row stores: v1 is superseded by
      // whichever later row names it. The banner on a superseded PDF is printed from this.
      supersededByVersion: supersededByOf(history, row.id),
      amendmentReason: row.amendmentReason,
      createdAt: row.createdAt,
      actionNeeded: row.actionNeeded,
      actionNeededMessage: row.actionNeededMessage,
      // An amendment's turnaround is the time from when v(n+1) was created to when it was
      // signed. The data is already on the row (signedAt - createdAt for rows where
      // supersedesReportId is not null), but surfacing it here means a contract that prices
      // corrections can read the number without deriving it from two timestamps.
      amendmentTurnaroundMinutes: row.supersedesReportId !== null && row.signedAt !== null
        ? Math.round((row.signedAt.getTime() - row.createdAt.getTime()) / 60000)
        : null,
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
        // Desk roles only, and the reason is carried beside it so the screen can say why a
        // row it can see is a row it cannot release.
        deliver: deliverable.ok && me !== null && DESK_ROLES.includes(me.role),
        // Whether this caller should be shown the delivery panel at all, as distinct from
        // whether the row may be released: a blocked desk row says why it is blocked, and a
        // reader who has no part in releasing it sees nothing.
        showDelivery: me !== null && DESK_ROLES.includes(me.role),
        // A reader may *try* to declare; who may actually do it for this study — the one
        // holding the case or the one who wrote the report on it — is the route's question,
        // and it answers `not_your_case` in the reader's own words.
        declareCritical: me !== null && READER_ROLES.includes(me.role),
        // Any role that may read the report may take the document: the clinic's own doctor
        // asking "what did you send us" is answered by the same bytes.
        download: DOWNLOADABLE.includes(row.state),
      },
      delivery: {
        channel: 'portal' as const,
        recipient: row.referringName ?? 'referring clinician not recorded',
        decision: deliverable.ok ? null : deliverable.reason,
        pdfSha256: row.pdfSha256,
        openCriticals,
        // One entry per queued channel. `sent` here means a relay took the message, not that a
        // human read it, and the screen has to keep those apart — the same reason the critical
        // loop exists at all.
        outbox,
      },
      // The loops themselves, not only their count: a desk refused `critical_unacknowledged`
      // has to be able to see who the reader phoned and when the acknowledgement fell due, or
      // the next act is a telephone call to find out what the screen already knew.
      criticals,
      history,
      study: {
        accession: row.accession,
        modality: row.modality,
        subSpecialty: row.subSpecialty,
        priority: row.priority,
        studyDate: row.studyDate,
        tenantCode: row.tenantCode,
        centreName: row.centreName,
        requiresReviewer: row.requiresReviewer,
        needsSecondName: needsSecondName({
          state: row.state,
          requiresReviewer: row.requiresReviewer,
          hasReviewer: row.reviewerUserId !== null,
        }),
      },
      patient: {
        name: row.patientName, mrn: row.patientMrn, dob: row.patientDob,
        age: row.patientAge, gender: row.patientGender,
      },
    };
  }

  // The document prints UTC and says so. A center in Kolkata and a reader in Dubai are
  // looking at the same signature line, and a bare `03:10` between them is a dispute.
  const utc = (value: Date | null): string | null =>
    value === null ? null : `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  // `dob` is a timestamp without a zone, so postgres.js hands back a Date carrying the
  // wall time that was stored. Reading it with the local getters prints the birthday the
  // desk typed; `toISOString()` would shift a midnight-of-the-1st to the previous day.
  const dateOnly = (value: Date | null): string | null => value === null ? null
    : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

  const dicomDate = (value: string | null): string | null =>
    value === null ? null : /^(\d{4})(\d{2})(\d{2})$/.exec(value)?.slice(1).join('-') ?? value;

  function pdfInputOf(
    row: ReportView,
    extra: {
      supersedesVersion: number | null;
      supersededByVersion: number | null;
      criticals?: DescribedCritical[];
    },
  ): ReportPdfInput {
    return {
      centreName: row.centreName ?? row.tenantCode ?? 'Radiology centre',
      tenantCode: row.tenantCode ?? '—',
      accession: row.accession ?? `study-${row.studyId}`,
      modality: row.modality,
      subSpecialty: row.subSpecialty,
      priority: row.priority ?? 'routine',
      studyDate: dicomDate(row.studyDate),
      receivedAt: utc(row.receivedAt),
      patient: {
        name: row.patientName ?? 'Patient not linked',
        mrn: row.patientMrn ?? '—',
        sex: row.patientGender ?? 'U',
        age: row.patientAge,
        dob: dateOnly(row.patientDob),
      },
      referring: {
        name: row.referringName,
        registration: row.referringRegistration,
        phone: row.referringPhone,
      },
      version: row.version,
      state: row.state,
      requiresReviewer: row.requiresReviewer,
      supersedesVersion: extra.supersedesVersion,
      supersededByVersion: extra.supersededByVersion,
      amendmentReason: row.amendmentReason,
      sections: row.sections,
      author: { name: row.authorName, registration: row.authorRegistration },
      reviewer: row.reviewerUserId === null ? null
        : { name: row.reviewerName ?? 'unnamed', registration: row.reviewerRegistration ?? '—' },
      signedAt: utc(row.signedAt),
      verifiedAt: utc(row.verifiedAt),
      // Mapped here rather than in the renderer, so the document keeps printing whatever the
      // loop actually said instead of knowing anything about the row it came from.
      criticals: (extra.criticals ?? []).map((c) => ({
        code: c.conditionCode,
        label: c.text,
        told: c.receiverName === null ? null
          : `Told ${c.receiverName}${c.receiverRole ? ` (${c.receiverRole})` : ''}`
            + ` by ${c.channel ?? 'an unrecorded channel'}`,
        acknowledgedAt: utc(c.acknowledgedAt),
        deadlineAt: utc(c.deadlineAt),
      })),
    };
  }

  /**
   * What the queue holds for this report version. Read out with the report because the desk's
   * next question after "delivered" is always "so did the clinic hear", and a panel that cannot
   * answer it sends somebody to the database.
   */
  async function outboxOf(reportId: number) {
    return await db.select({
      id: reportDeliveries.id,
      channel: reportDeliveries.channel,
      recipient: reportDeliveries.recipient,
      status: reportDeliveries.status,
      attemptNo: reportDeliveries.attemptNo,
      nextAttemptAt: reportDeliveries.nextAttemptAt,
      sentAt: reportDeliveries.sentAt,
      errorCode: reportDeliveries.errorCode,
    }).from(reportDeliveries)
      .where(eq(reportDeliveries.reportId, reportId))
      .orderBy(reportDeliveries.channel);
  }

  async function respond(res: Response, p: Principal, reportId: number, status = 200) {
    const row = await loadReport(reportId);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const [me, author] = await Promise.all([profileOf(p.userId), profileOf(row.authorUserId)]);
    // Described for *this* caller: the same open loop is an action for the desk and a status
    // line for the reader who phoned, and a screen that offered the reader the Ack button would
    // let them close a loop nobody at the clinic has actually confirmed.
    const now = new Date();
    const criticals = (await criticalsForStudy(db, row.studyId))
      .map((c) => describeCritical(c, now, DESK_ROLES.includes(p.role)));
    const outbox = await outboxOf(row.id);
    return res.status(status).json({
      ok: true,
      // The grade comes from the clinician profile and may legitimately be missing (a desk
      // account has none); the role comes from the session and always exists. They are not
      // the same lookup, and conflating them would grey out a button for the wrong reason.
      report: describeReport(row, await versionsOf(row.studyId),
        { userId: p.userId, role: p.role, grade: me?.grade ?? null },
        author?.grade ?? null, criticals, outbox),
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
      createdAt: reports.createdAt,
      supersedesReportId: reports.supersedesReportId,
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
    const now = new Date();
    const out = rows.map((row) => {
      const decision = countersignDecision({
        state: 'signed',
        authorUserId: row.authorUserId,
        reviewerUserId: p.userId,
        authorGrade: row.authorGrade,
        reviewerGrade: me?.grade ?? null,
      });
      // The query filters by state='signed', so signedAt is always present. The schema
      // allows null because a draft has not been signed yet, but that row never reaches
      // this map.
      const signedAt = row.signedAt!;
      return {
        ...row,
        // How long this report has been waiting for a second name, in minutes. A reviewer
        // staring at a queue needs to see which row has been sitting there since 02:13, not
        // just the order it arrived in.
        waitingMinutes: Math.round((now.getTime() - signedAt.getTime()) / 60000),
        // An amendment waiting for review is a different thing from a first signature: the
        // center was already answered, and this is a correction. The reviewer needs to know
        // because an amendment carries a different urgency than a first read.
        isAmendment: row.supersedesReportId !== null,
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

  // Declared before '/reports/:id' with the other word-prefixed paths. This is the desk's
  // list: everything that carries a signature and has not yet gone to the clinic, with the
  // reason any row on it cannot go.
  r.get('/reports/awaiting-delivery', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const p = req.principal!;
    const scope = scopeTenant(p);

    const rows = await db.select({
      reportId: reports.id,
      studyId: reports.studyId,
      version: reports.version,
      state: reports.state,
      signedAt: reports.signedAt,
      verifiedAt: reports.verifiedAt,
      // The id rather than a boolean: the same value answers "is there a second name" and
      // is the only thing a reader can check the row against on screen.
      reviewerUserId: reports.reviewerUserId,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: studies.priority,
      requiresReviewer: subSpecialties.requiresReviewer,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      referringName: orders.referringName,
      tenantCode: tenants.code,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(orders, eq(orders.id, studies.orderId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .leftJoin(subSpecialties, eq(subSpecialties.code, studies.subSpecialtyCode))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .where(and(
        scope === null ? sql`true` : eq(reports.tenantId, scope),
        inArray(reports.state, DELIVER_STATES),
      ))
      .orderBy(reports.signedAt);

    // One grouped query for the page rather than one per row: the desk board is a list, and a
    // reader scrolling it should not cost a round trip per study.
    const openByStudy = await openCriticalCounts(db, rows.map((row) => row.studyId));

    // Per row, because the answer depends on the row's own sub-specialty: a signed MRI that
    // is waiting on a second name and a signed chest film that never needed one are both
    // "not delivered", and only one of them is a gap someone has to chase.
    const out = rows.map((row) => {
      const openCriticals = openByStudy.get(row.studyId) ?? 0;
      const decision = deliverDecision({
        state: row.state,
        requiresReviewer: row.requiresReviewer ?? false,
        hasReviewer: row.reviewerUserId !== null,
        openCriticals,
      });
      return {
        ...row,
        deliverable: decision.ok,
        reason: decision.ok ? null : decision.reason,
        openCriticals,
        needsSecondName: needsSecondName({
          state: row.state,
          requiresReviewer: row.requiresReviewer ?? false,
          hasReviewer: row.reviewerUserId !== null,
        }),
      };
    });

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'report.delivery_queue', entity: 'reports',
      detail: {
        count: out.length,
        blocked: out.filter((o) => !o.deliverable).length,
        // Split by cause, because they are different people's work: a row blocked for a second
        // name needs a reviewer, and a row blocked for an open critical loop needs a phone call.
        blockedByCritical: out.filter((o) => o.reason === 'critical_unacknowledged').length,
        blockedByReview: out.filter((o) => o.reason === 'review_required').length,
      },
    });
    res.json({
      ok: true,
      generatedAt: new Date(),
      counts: {
        total: out.length,
        ready: out.filter((o) => o.deliverable).length,
        blockedByCritical: out.filter((o) => o.reason === 'critical_unacknowledged').length,
      },
      awaiting: out,
    });
  }));

  // Declared before '/reports/:id' with the other word-prefixed paths. The queue's own board:
  // every notice that has not been delivered to the clinic yet, and the reason. `dead` is a
  // state that means nothing unless somebody is shown it, and a report whose release was
  // recorded while its notice quietly stopped being sent is the failure this screen exists to
  // make loud.
  r.get('/reports/outbox', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const p = req.principal!;
    const scope = scopeTenant(p);

    const rows = await db.select({
      id: reportDeliveries.id,
      reportId: reportDeliveries.reportId,
      studyId: reports.studyId,
      channel: reportDeliveries.channel,
      status: reportDeliveries.status,
      recipient: reportDeliveries.recipient,
      attemptNo: reportDeliveries.attemptNo,
      nextAttemptAt: reportDeliveries.nextAttemptAt,
      sentAt: reportDeliveries.sentAt,
      errorCode: reportDeliveries.errorCode,
      version: reports.version,
      state: reports.state,
      accession: studies.accessionNumber,
      tenantCode: tenants.code,
    }).from(reportDeliveries)
      .innerJoin(reports, eq(reports.id, reportDeliveries.reportId))
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .where(and(
        scope === null ? sql`true` : eq(reportDeliveries.tenantId, scope),
        // Unsent work only. A clinic that has been told is not a row anybody needs to see.
        inArray(reportDeliveries.status, ['pending', 'failed', 'dead']),
      ))
      .orderBy(reportDeliveries.nextAttemptAt);

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'report.outbox_board', entity: 'report_deliveries',
      detail: {
        count: rows.length,
        dead: rows.filter((row) => row.status === 'dead').length,
        scope: scope === null ? 'platform' : 'tenant',
      },
    });
    res.json({
      ok: true,
      generatedAt: new Date(),
      counts: {
        queued: rows.filter((row) => row.status !== 'dead').length,
        dead: rows.filter((row) => row.status === 'dead').length,
      },
      // Whether this deployment can send at all is the worker's business, not this route's: a
      // row that has never been attempted carries `attemptNo: 0` and no error code, which is the
      // honest signal that nothing has tried yet, and the worker's boot line names the relay.
      outbox: rows,
    });
  }));

  // Full-text search across signed reports. The sections column is JSONB — a dictionary
  // pasted into a structured form — and the search has to reach into every value without
  // knowing the key names in advance. `jsonb_each_text` flattens the object into rows the
  // text-search vector can be built from, and a GIN index on the expression would make
  // this fast at scale; for now the query runs against the signed set, which is the set
  // a clinician searches, and it is small enough that a sequential scan answers in time.
  r.get('/reports/search', ah(async (req: Ctx, res) => {
    const p = req.principal!;
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      return res.status(422).json({ ok: false, error: 'query must be at least 2 characters' });
    }
    if (q.length > 200) {
      return res.status(422).json({ ok: false, error: 'query too long' });
    }
    const scope = scopeTenant(p);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    // The search term is interpolated as a bind parameter, never into the SQL text.
    // `plainto_tsquery` tokenises the input and ignores operators, which is what a
    // clinician typing "left lung nodule" expects — three words, any order, all present.
    const rows = await db.select({
      id: reports.id,
      studyId: reports.studyId,
      version: reports.version,
      state: reports.state,
      authorName: reports.authorName,
      signedAt: reports.signedAt,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      tenantCode: tenants.code,
      centreName: tenants.legalName,
    }).from(reports)
      .innerJoin(studies, eq(studies.id, reports.studyId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .leftJoin(tenants, eq(tenants.id, reports.tenantId))
      .where(and(
        inArray(reports.state, ['signed', 'verified', 'delivered', 'amended']),
        scope === null ? undefined : eq(reports.tenantId, scope),
        sql`exists (
          select 1 from jsonb_each_text(${reports.sections}) kv
          where to_tsvector('english', kv.value) @@ plainto_tsquery('english', ${q})
        )`,
      ))
      .orderBy(desc(reports.signedAt))
      .limit(limit);

    // The reader who searches must be able to read what comes back. A cross-tenant
    // search is refused at the scope filter above; within the tenant, a draft is not
    // returned because the state filter already excludes it, and a signed report is
    // shown only to readers the `mayReadReport` rule permits — which, for signed
    // reports, is every radiologist in the tenant.
    res.json({
      ok: true,
      query: q,
      results: rows.map((row) => ({
        id: row.id,
        studyId: row.studyId,
        version: row.version,
        state: row.state,
        authorName: row.authorName,
        signedAt: row.signedAt,
        accession: row.accession,
        modality: row.modality,
        patientName: row.patientName,
        patientMrn: row.patientMrn,
        tenantCode: row.tenantCode,
        centreName: row.centreName,
      })),
    });
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

  r.post('/reports/:id/deliver', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);

    const history = await versionsOf(row.studyId);
    const now = new Date();
    const criticals = (await criticalsForStudy(db, row.studyId))
      .map((c) => describeCritical(c, now, true));
    const openCriticals = criticals.filter((c) => c.acknowledgedAt === null).length;

    const decision = deliverDecision({
      state: row.state,
      requiresReviewer: row.requiresReviewer,
      hasReviewer: row.reviewerUserId !== null,
      openCriticals,
    });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    // Rendered first, and only then recorded. A delivery that flipped the state and then
    // failed to produce a document would leave a report marked as sent with nothing behind
    // it — which is the worst of the orderings, because the clinic is told and the bytes
    // do not exist.
    const rendered = await renderReportPdf(pdfInputOf(row, {
      supersedesVersion: versionOf(history, row.supersedesReportId),
      supersededByVersion: supersededByOf(history, row.id),
      criticals,
    }));

    const [delivered] = await db.update(reports)
      .set({ state: 'delivered', deliveredAt: now, pdfSha256: rendered.sha256 })
      .where(and(eq(reports.id, id), inArray(reports.state, DELIVER_STATES)))
      .returning({ id: reports.id });
    if (!delivered) return res.status(409).json({ ok: false, error: 'not_deliverable' });

    await db.update(slaClocks).set({ deliveredAt: now })
      .where(and(eq(slaClocks.studyId, row.studyId), isNull(slaClocks.deliveredAt)));

    await db.insert(reportDeliveries).values({
      reportId: id,
      tenantId: row.tenantId,
      channel: 'portal',
      recipient: row.referringName ?? 'the referring clinic',
      status: 'sent',
      attemptNo: 1,
      sentAt: now,
      idempotencyKey: deliveryIdempotencyKey({ reportId: id, version: row.version, channel: 'portal' }),
    }).onConflictDoNothing({ target: reportDeliveries.idempotencyKey });

    // The email is *queued*, never sent from this request. A desk pressing Deliver must get its
    // answer in the time it takes to click, and a mail relay that takes nine seconds — or is
    // down, or greylisting — cannot be allowed to become a report that failed to be released.
    // The row is the promise; the worker keeps it.
    const emailQueued = row.referringEmail !== null;
    if (row.referringEmail !== null) {
      await db.insert(reportDeliveries).values({
        reportId: id,
        tenantId: row.tenantId,
        channel: 'email',
        recipient: row.referringEmail,
        status: 'pending',
        attemptNo: 0,
        nextAttemptAt: now,
        idempotencyKey: deliveryIdempotencyKey({ reportId: id, version: row.version, channel: 'email' }),
      }).onConflictDoNothing({ target: reportDeliveries.idempotencyKey });
    }

    // The whatsapp row is queued on the same terms as the email: the row is the promise, the
    // worker keeps it, and whether Meta's credentials exist is the worker's concern, not the
    // desk's. A phone that is not a full international number queues nothing — completing it
    // with a guessed country code is how a notice ends up in somebody else's chat.
    const waPhone = normalisePhone(row.referringPhone);
    const whatsappQueued = waPhone !== null;
    if (waPhone !== null) {
      await db.insert(reportDeliveries).values({
        reportId: id,
        tenantId: row.tenantId,
        channel: 'whatsapp',
        recipient: waPhone,
        status: 'pending',
        attemptNo: 0,
        nextAttemptAt: now,
        idempotencyKey: deliveryIdempotencyKey({ reportId: id, version: row.version, channel: 'whatsapp' }),
      }).onConflictDoNothing({ target: reportDeliveries.idempotencyKey });
    }

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.delivered', entity: 'reports', entityId: String(id),
      detail: {
        studyId: row.studyId,
        version: row.version,
        channel: 'portal',
        recipient: { name: row.referringName, registration: row.referringRegistration },
        // The hash of the document that left, stored on the report row as well: the answer
        // to "is this the PDF you were sent" has to be one read away, not a re-render away.
        pdfSha256: rendered.sha256,
        pdfBytes: rendered.bytes.length,
        pdfPages: rendered.pages,
        requiredSecondName: row.requiresReviewer,
        // Whether the clinic is about to be told, and to what address, per channel. Recorded at
        // the moment of release rather than derived later, because the referral can be edited
        // afterwards and the question "did you email Dr Rao" is about this instant. A phone that
        // never normalised is named as such rather than folded into "no phone": the record shows
        // the desk typed something, and what they typed was not usable.
        notification: {
          email: emailQueued
            ? { channel: 'email', recipient: row.referringEmail, status: 'pending' }
            : { channel: 'email', recipient: null, status: 'no_referring_email' },
          whatsapp: whatsappQueued
            ? { channel: 'whatsapp', recipient: waPhone, status: 'pending' }
            : {
                channel: 'whatsapp',
                recipient: null,
                status: row.referringPhone === null ? 'no_referring_phone' : 'referring_phone_unusable',
              },
        },
        // Every loop that was open or closed at the moment the document left, with the name
        // that closed it. This is the row an investigator reads to establish that a critical
        // finding was acknowledged *before* the report went out rather than after.
        criticals: criticals.map((c) => ({
          code: c.conditionCode,
          receiver: c.receiverName,
          channel: c.channel,
          acknowledgedAt: c.acknowledgedAt,
          acknowledgedByName: c.acknowledgedByName,
          late: c.late,
        })),
      },
    });
    return respond(res, p, id);
  }));

  r.get('/reports/:id/pdf', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);
    if (!mayRead(row, p)) return await denied(res, p, String(id), false);
    if (!DOWNLOADABLE.includes(row.state)) return res.status(409).json({ ok: false, error: 'not_signed' });

    const history = await versionsOf(row.studyId);
    // The same block the delivered copy carried: a re-download of a report that went out with
    // an open loop has to show that loop still open, or the document stops being evidence.
    const now = new Date();
    const criticals = (await criticalsForStudy(db, row.studyId))
      .map((c) => describeCritical(c, now, true));
    const rendered = await renderReportPdf(pdfInputOf(row, {
      supersedesVersion: versionOf(history, row.supersedesReportId),
      supersededByVersion: supersededByOf(history, row.id),
      criticals,
    }));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.pdf_downloaded', entity: 'reports', entityId: String(id),
      detail: {
        studyId: row.studyId,
        version: row.version,
        state: row.state,
        bytes: rendered.bytes.length,
        pages: rendered.pages,
        sha256: rendered.sha256,
        // Compared, not assumed. If the rendering ever changes under a report that was
        // already delivered, the audit row says so and the operator sees a mismatch rather
        // than a document nobody can vouch for.
        recordSha256: row.pdfSha256,
        matchesRecord: row.pdfSha256 === null ? null : row.pdfSha256 === rendered.sha256,
      },
    });

    // Patient data, on demand, so nothing about it is cacheable — and named for the
    // accession rather than the patient, because a reception machine keeps what it is given.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${reportPdfFilename(row.accession ?? `study-${row.studyId}`, row.version)}"`);
    res.send(Buffer.from(rendered.bytes));
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

  // A desk flagging a report as needing action is a different act from amending it: the words
  // on the document are not in question, but the clinic needs to know something before the
  // paper leaves. The flag travels with the report until someone clears it.
  r.post('/reports/:id/action-needed', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null;
    const set = req.body?.set !== false;
    await db.update(reports).set({
      actionNeeded: set,
      actionNeededMessage: set ? message : null,
    }).where(eq(reports.id, id));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: set ? 'report.action_needed_set' : 'report.action_needed_cleared',
      entity: 'reports', entityId: String(id),
      detail: { studyId: row.studyId, message: set ? message : null },
    });
    return respond(res, p, id);
  }));

  // A rating is the clinic's judgement of the report they received, not the reader's own
  // assessment. One rating per report: a second opinion about quality is an amendment, not a
  // second star.
  r.post('/reports/:id/rate', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const p = req.principal!;
    const row = await loadReport(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id), true);

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(422).json({ ok: false, error: 'rating_must_be_1_to_5' });
    }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : null;

    await db.insert(reportRatings).values({
      reportId: id,
      tenantId: row.tenantId,
      authorUserId: p.userId,
      rating,
      comment,
    }).onConflictDoUpdate({
      target: reportRatings.reportId,
      set: { rating, comment },
    });

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'report.rated', entity: 'reports', entityId: String(id),
      detail: { studyId: row.studyId, rating, comment },
    });
    return res.json({ ok: true, reportId: id, rating, comment });
  }));

  return r;
}
