import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  type Db, appendAudit, assignments, criticalEvents, reports, studies,
} from '@telrad/db';
import {
  CRITICAL_CHANNELS, CRITICAL_CONDITIONS, type CriticalChannel, ackDecision, criticalCondition,
  currentVersion, declareDecision,
} from '@telrad/shared';
import { Router, type Response } from 'express';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx, type Principal } from '../auth.js';
import { ah } from '../handler.js';
import {
  criticalById, describeCritical, openCriticalCount, openCriticals,
} from '../criticals-reads.js';

const READER_ROLES = ['radiologist', 'reviewer'];
// Closing the loop is a receiving-side act: the desk types the name of the clinician who said
// they heard it. A reader who could acknowledge their own declaration could release a report
// they had phoned about but never reached, which is the exact failure this table exists to
// prevent. That is also why the role list below has no radiologist in it.
const DESK_ROLES = ['center_staff', 'owner', 'console'];
// The assignment states that mean "this case is on this reader's desk right now".
const HOLD_STATES: ('accepted' | 'reading')[] = ['accepted', 'reading'];
const MAX_NAME_CHARS = 120;
const MAX_DETAIL_CHARS = 2_000;
const MAX_PHONE_CHARS = 32;
const MAX_CODE_CHARS = 64;

type Field = { value: string | null; error: string | null };

/**
 * Text fields, trimmed and capped here rather than by the column: a `text` column will accept
 * a pasted dictionary, and these values are printed on a document and read aloud over the
 * phone. An empty string becomes null, because the rule asks "is there a name" and a space is
 * not one.
 */
function text(input: unknown, max: number, field: string): Field {
  if (input === undefined || input === null) return { value: null, error: null };
  if (typeof input !== 'string') return { value: null, error: `bad_${field}` };
  const value = input.trim();
  if (value === '') return { value: null, error: null };
  if (value.length > max) return { value: null, error: `${field}_too_long` };
  return { value, error: null };
}

function bad(res: Response, error: string): Response {
  return res.status(400).json({ ok: false, error });
}

/**
 * Declaring a critical finding, acknowledging it, and the board of loops still open.
 *
 * The rules live in `@telrad/shared/src/criticals.ts`; this file is I/O, the tenant wall and
 * the audit trail. What is deliberately absent is any inference from the report text: a row
 * enters this table because a named reader said the finding is critical and named who they
 * told, never because a word matched.
 */
export function criticalsRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/criticals'], requireAuth(db)));

  async function denied(res: Response, p: Principal, entityId: string): Promise<Response> {
    // Recorded against the actor's tenant: the question an operator asks afterwards is why one
    // of my readers was poking at another center's ids.
    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'critical.denied_cross_tenant', entity: 'critical_events', entityId,
    });
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  r.get('/criticals', ah(async (req: Ctx, res) => {
    const p = req.principal!;
    const scope = scopeTenant(p);
    const studyId = req.query.studyId === undefined ? undefined : Number(req.query.studyId);
    if (studyId !== undefined && !Number.isInteger(studyId)) return bad(res, 'bad_id');
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);

    const rows = await openCriticals(db, { tenantId: scope, studyId, limit });
    // A reader sees the same board with the same three states; the only difference is that
    // they cannot be offered the act of closing it.
    const mayAck = DESK_ROLES.includes(p.role);
    const now = new Date();
    const described = rows.map((row) => describeCritical(row, now, mayAck));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'critical.board', entity: 'critical_events',
      detail: {
        count: described.length,
        breached: described.filter((c) => c.state === 'breached').length,
        scope: scope === null ? 'platform' : 'tenant',
        studyId: studyId ?? null,
      },
    });
    res.json({
      ok: true,
      generatedAt: now,
      counts: { open: described.length, breached: described.filter((c) => c.state === 'breached').length },
      criticals: described,
    });
  }));

  // The form the reader fills in is drawn from this rather than from a copy in the browser, so
  // the minute figure on the screen is the one the server is about to enforce.
  r.get('/criticals/catalogue', ah(async (req: Ctx, res) => {
    res.json({
      ok: true,
      conditions: CRITICAL_CONDITIONS,
      channels: CRITICAL_CHANNELS,
    });
  }));

  r.post('/criticals', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, READER_ROLES, res)) return undefined;
    const p = req.principal!;
    const studyId = Number(req.body?.studyId);
    if (!Number.isInteger(studyId)) return bad(res, 'bad_id');

    const [study] = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      accession: studies.accessionNumber,
    }).from(studies).where(eq(studies.id, studyId)).limit(1);
    if (!study) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && study.tenantId !== scope) return await denied(res, p, String(studyId));
    // `tenant_id` is NOT NULL here and an orphan study has none yet. A finding on a study that
    // belongs to nobody cannot be phoned to anybody, so it is refused rather than filed
    // against an invented center.
    if (study.tenantId === null) return res.status(409).json({ ok: false, error: 'study_unlinked' });

    // Two doors, both needed. Holding the case covers the reader who picks up the phone before
    // they have written anything; having written the report on it covers the one who signed at
    // 03:00, completed the assignment, and called the clinic at 03:15 — which is the ordinary
    // order of events, and the case a single-door rule would silently refuse.
    const [held] = await db.select({ id: assignments.id }).from(assignments)
      .where(and(
        eq(assignments.studyId, studyId),
        eq(assignments.clinicianUserId, p.userId),
        inArray(assignments.state, HOLD_STATES),
      )).limit(1);

    // The *live* version, not any version this reader once signed. A correction changes hands:
    // the reader whose v1 was superseded is no longer the person who owns what the study says,
    // and letting them declare against it would attach a finding to a document they have been
    // replaced on. `currentVersion` excludes the amended and withdrawn rows for the same
    // reason the report desk does.
    const versions = await db.select({
      id: reports.id,
      version: reports.version,
      state: reports.state,
      authorUserId: reports.authorUserId,
    }).from(reports).where(eq(reports.studyId, studyId));
    const live = currentVersion(versions);
    const authored = live !== null && live.authorUserId === p.userId ? live : null;
    if (!held && !authored) return res.status(403).json({ ok: false, error: 'not_your_case' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = {
      condition: text(body.condition, MAX_CODE_CHARS, 'condition'),
      channel: text(body.channel, 24, 'channel'),
      receiverName: text(body.receiverName, MAX_NAME_CHARS, 'receiver_name'),
      receiverRole: text(body.receiverRole, MAX_NAME_CHARS, 'receiver_role'),
      receiverPhone: text(body.receiverPhone, MAX_PHONE_CHARS, 'receiver_phone'),
      detail: text(body.detail, MAX_DETAIL_CHARS, 'detail'),
    };
    const firstError = Object.values(fields).find((f) => f.error !== null);
    if (firstError) return bad(res, firstError.error!);

    const decision = declareDecision({
      condition: fields.condition.value,
      channel: fields.channel.value,
      receiverName: fields.receiverName.value,
      receiverPhone: fields.receiverPhone.value,
      detail: fields.detail.value,
    });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    // One instant for the whole row, and it is the server's. `notified_at` is the column every
    // deadline in this loop is measured from, and accepting it from the caller would let a
    // service backdate last night's breach into this morning's compliance.
    const now = new Date();
    const [inserted] = await db.insert(criticalEvents).values({
      studyId,
      reportId: authored?.id ?? null,
      tenantId: study.tenantId,
      conditionCode: fields.condition.value!,
      detail: fields.detail.value,
      detectedByUserId: p.userId,
      detectedAt: now,
      notifiedAt: now,
      channel: fields.channel.value as CriticalChannel,
      receiverName: fields.receiverName.value,
      receiverRole: fields.receiverRole.value,
      receiverPhone: fields.receiverPhone.value,
      // Snapshotted from the catalogue at the moment of declaration. If the SLA for a code is
      // renegotiated next year, this row still answers the number it promised.
      slaMinutes: criticalCondition(fields.condition.value).slaMinutes,
    }).returning({ id: criticalEvents.id });

    const created = await criticalById(db, inserted!.id);
    const described = describeCritical(created!, now, DESK_ROLES.includes(p.role));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: study.tenantId,
      action: 'critical.declared', entity: 'critical_events', entityId: String(inserted!.id),
      detail: {
        studyId,
        accession: study.accession,
        reportId: authored?.id ?? null,
        reportVersion: authored?.version ?? null,
        conditionCode: created!.conditionCode,
        channel: created!.channel,
        receiverName: created!.receiverName,
        receiverRole: created!.receiverRole,
        slaMinutes: created!.slaMinutes,
        deadlineAt: described.deadlineAt.toISOString(),
        via: held ? 'assignment' : 'report_authorship',
      },
    });

    // The declaration is not a note beside the report: it is a second gate on the document.
    // Saying so in the response is what keeps the desk from reading the refusal it is about to
    // get as a bug in delivery.
    res.status(201).json({
      ok: true,
      critical: described,
      blocksDelivery: true,
      via: held ? 'assignment' : 'report_authorship',
    });
  }));

  r.post('/criticals/:id/ack', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, DESK_ROLES, res)) return undefined;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 'bad_id');
    const p = req.principal!;

    const row = await criticalById(db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const scope = scopeTenant(p);
    if (scope !== null && row.tenantId !== scope) return await denied(res, p, String(id));

    const nameField = text(req.body?.acknowledgedByName, MAX_NAME_CHARS, 'acknowledged_by_name');
    const roleField = text(req.body?.acknowledgedByRole, MAX_NAME_CHARS, 'acknowledged_by_role');
    if (nameField.error) return bad(res, nameField.error);
    if (roleField.error) return bad(res, roleField.error);

    const decision = ackDecision({
      alreadyAcknowledged: row.acknowledgedAt !== null,
      acknowledgedByName: nameField.value,
    });
    if (!decision.ok) return res.status(422).json({ ok: false, error: decision.reason });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const phoneField = text(body.receiverPhone, MAX_PHONE_CHARS, 'receiver_phone');
    if (phoneField.error) return bad(res, phoneField.error);

    const now = new Date();
    // Conditional on the loop still being open, because two desks answering the same phone call
    // is normal, and the *first* acknowledgement is the one the deadline is measured against.
    const [closed] = await db.update(criticalEvents).set({
      acknowledgedAt: now,
      acknowledgedByName: nameField.value,
      acknowledgedByUserId: p.userId,
      // The number the clinician rang back from, when the desk records it. Written only when
      // the declaration did not already carry one — a phone call placed to a number nobody can
      // read back is a claim that cannot be checked.
      receiverPhone: row.receiverPhone ?? phoneField.value,
    }).where(and(eq(criticalEvents.id, id), isNull(criticalEvents.acknowledgedAt)))
      .returning({ id: criticalEvents.id });
    if (!closed) return res.status(409).json({ ok: false, error: 'already_acknowledged' });

    // Re-read rather than re-use: the row now carries the acknowledgement, and the state that
    // gets back to the screen has to be the state in the table.
    const updated = await criticalById(db, id);
    const described = describeCritical(updated!, now, true);

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'critical.acknowledged', entity: 'critical_events', entityId: String(id),
      detail: {
        studyId: row.studyId,
        accession: row.accession,
        conditionCode: row.conditionCode,
        acknowledgedByName: nameField.value,
        acknowledgedByRole: roleField.value,
        // Minutes between the call being placed and this name being typed: the number the
        // whole loop exists to make somebody look at.
        minutesFromNotifyToAck: Math.round((now.getTime()
          - (row.notifiedAt ?? row.detectedAt).getTime()) / 60_000),
        late: described.late,
        // A breach the worker already stamped is not erased by closing the loop; the row stays
        // a finding, which is why this is recorded rather than recomputed later.
        breachedAtDeclaration: row.breached,
        openRemainingForStudy: await openCriticalCount(db, row.studyId),
      },
    });
    res.json({
      ok: true,
      critical: described,
      openForStudy: await openCriticalCount(db, row.studyId),
    });
  }));

  return r;
}
