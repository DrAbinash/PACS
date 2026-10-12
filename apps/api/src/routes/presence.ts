import { and, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  assignments,
  clinicianProfiles,
  readerAvailability,
  reports,
  rosters,
  users,
} from '@telrad/db';
import { PRESENCE_LABEL, readerPresence, type ReaderState } from '@telrad/shared';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const READER_ROLES = ['radiologist', 'reviewer'];
const PANEL_ROLES = ['owner', 'console', 'radiologist', 'reviewer'];

export function presenceRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/presence', '/panel'], requireAuth(db)));

  async function openCaseCounts(): Promise<Map<number, number>> {
    const rows = await db.select({
      userId: assignments.clinicianUserId,
      n: sql<number>`count(*)::int`,
    }).from(assignments)
      .where(inArray(assignments.state, ['offered', 'accepted', 'reading']))
      .groupBy(assignments.clinicianUserId);
    return new Map(rows.map((row) => [row.userId, row.n]));
  }

  // The sidebar the desk reads at 2 a.m. needs one more number than "how many open
  // cases": how many has this reader signed today. A reader with three open and twelve
  // signed is working flat out; one with three open and zero signed since 22:00 is the
  // person you call. The count is per calendar day in UTC, which is the same clock the
  // report signature line prints.
  async function signedTodayCounts(): Promise<Map<number, number>> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const rows = await db.select({
      userId: reports.authorUserId,
      n: sql<number>`count(*)::int`,
    }).from(reports)
      .where(sql`${reports.signedAt} >= ${todayStart.toISOString()}::timestamptz`)
      .groupBy(reports.authorUserId);
    return new Map(rows.map((row) => [row.userId, row.n]));
  }

  async function onShiftWindow(tenantId: number | null, now: Date): Promise<Map<number, { startsAt: Date; endsAt: Date; kind: string }>> {
    const rows = await db.select({
      userId: rosters.userId, startsAt: rosters.startsAt, endsAt: rosters.endsAt, kind: rosters.kind,
    }).from(rosters).where(and(
      // lte/gt rather than a raw sql comparison: a Date interpolated into a sql
      // template reaches postgres.js untyped and it throws while encoding the
      // parameter, which took the whole process down on the first panel read.
      lte(rosters.startsAt, now),
      gt(rosters.endsAt, now),
      ne(rosters.status, 'cancelled'),
      tenantId === null ? undefined : eq(rosters.tenantId, tenantId),
    )).orderBy(rosters.startsAt);
    const byUser = new Map<number, { startsAt: Date; endsAt: Date; kind: string }>();
    for (const row of rows) if (!byUser.has(row.userId)) byUser.set(row.userId, row);
    return byUser;
  }

  // The reader's browser calls this on a timer while the console tab is open.
  //
  // It deliberately does not un-pause anybody: a heartbeat proves the tab is alive,
  // not that the person wants work, so 'paused' and 'away' survive heartbeats and
  // only an explicit state change clears them. A brand-new row, or one last left at
  // 'offline', means they have just signed on and are asking for cases.
  r.post('/presence/heartbeat', ah(async (req: Ctx, res) => {
    if (!READER_ROLES.includes(req.principal!.role)) {
      return res.status(403).json({ ok: false, error: 'not_a_reader' });
    }
    const userId = req.principal!.userId;
    const now = new Date();
    const [current] = await db.select().from(readerAvailability).where(eq(readerAvailability.userId, userId)).limit(1);
    const declaresWork = !current || current.state === 'offline';

    const [row] = await db.insert(readerAvailability)
      .values({ userId, state: 'receiving', lastSeenAt: now, sinceAt: now })
      .onConflictDoUpdate({
        target: readerAvailability.userId,
        set: {
          lastSeenAt: now,
          ...(declaresWork ? { state: 'receiving' as ReaderState, sinceAt: now } : {}),
        },
      })
      .returning();

    const profile = await db.select().from(clinicianProfiles).where(eq(clinicianProfiles.userId, userId)).limit(1);
    const open = (await openCaseCounts()).get(userId) ?? 0;
    const presence = readerPresence({
      state: row!.state, lastSeenAt: row!.lastSeenAt, now,
      openCases: open, maxQueueSize: profile[0]?.maxQueueSize ?? 5,
    });
    // Heartbeats are not audited. Twenty seconds of polling per open tab would put
    // more rows in the hash chain than a year of clinical events, and the chain is
    // the thing an investigator reads.
    res.json({
      ok: true, color: presence.color, code: presence.code, label: PRESENCE_LABEL[presence.code],
      routable: presence.routable, openCases: open,
      maxQueueSize: profile[0]?.maxQueueSize ?? 5,
    });
  }));

  // Declaring a state is an operational fact worth keeping: "who was off the panel
  // at 02:00 when the STAT arrived" is a question a report desk gets asked.
  r.patch('/presence', ah(async (req: Ctx, res) => {
    if (!READER_ROLES.includes(req.principal!.role)) {
      return res.status(403).json({ ok: false, error: 'not_a_reader' });
    }
    const state = String(req.body?.state ?? '') as ReaderState;
    if (!['receiving', 'paused', 'away', 'offline'].includes(state)) {
      return res.status(422).json({ ok: false, error: 'state must be receiving, paused, away or offline' });
    }
    const userId = req.principal!.userId;
    const now = new Date();
    const [before] = await db.select({ state: readerAvailability.state }).from(readerAvailability)
      .where(eq(readerAvailability.userId, userId)).limit(1);

    const [row] = await db.insert(readerAvailability)
      .values({ userId, state, sinceAt: now, lastSeenAt: now, note: req.body?.note ? String(req.body.note).slice(0, 120) : null })
      .onConflictDoUpdate({
        target: readerAvailability.userId,
        set: { state, sinceAt: now, lastSeenAt: now },
      })
      .returning();

    await appendAudit(db, {
      actorUserId: userId, actorKind: 'human', tenantId: req.principal!.tenantId,
      action: 'presence.changed', entity: 'reader_availability', entityId: String(userId),
      detail: { from: before?.state ?? null, to: state },
    });
    res.json({ ok: true, state: row!.state });
  }));

  // The board itself. One endpoint serves both the operator's routing decision and
  // the reader's "who else is on" view, so the two can never disagree about who is
  // green — the colour is computed here, from the same inputs the dispatcher will
  // later filter on.
  r.get('/panel', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, PANEL_ROLES, res)) return undefined;
    const tenantId = scopeTenant(req.principal!);
    const now = new Date();
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

    const rows = await db.select({
      userId: users.id,
      name: users.displayName,
      role: users.role,
      tenantId: users.tenantId,
      status: users.status,
      grade: clinicianProfiles.grade,
      subspecialtyCodes: clinicianProfiles.subspecialtyCodes,
      modalityCodes: clinicianProfiles.modalityCodes,
      maxQueueSize: clinicianProfiles.maxQueueSize,
      registration: sql<string>`coalesce(${clinicianProfiles.registrationCouncil}, '') || ' / ' || coalesce(${clinicianProfiles.registrationNumber}, '')`,
      state: readerAvailability.state,
      lastSeenAt: readerAvailability.lastSeenAt,
      stateSince: readerAvailability.sinceAt,
    }).from(users)
      .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, users.id))
      .leftJoin(readerAvailability, eq(readerAvailability.userId, users.id))
      .where(and(
        // Inlined rather than reused from READER_ROLES: that constant is compared
        // against a plain string role, and an enum-typed inArray wants the literals.
        inArray(users.role, ['radiologist', 'reviewer']),
        eq(users.status, 'active'),
        tenantId === null ? undefined : eq(users.tenantId, tenantId),
      ))
      .orderBy(users.displayName).limit(limit);

    const open = await openCaseCounts();
    const signed = await signedTodayCounts();
    const shift = await onShiftWindow(tenantId, now);

    const panel = rows.map((row) => {
      const openCases = open.get(row.userId) ?? 0;
      const presence = readerPresence({
        state: row.state ?? 'offline',
        lastSeenAt: row.lastSeenAt,
        now,
        openCases,
        maxQueueSize: row.maxQueueSize ?? 5,
      });
      const window = shift.get(row.userId);
      return {
        userId: row.userId,
        name: row.name,
        role: row.role,
        grade: row.grade,
        registration: row.registration.replace(/^ \/ $/, ''),
        subspecialtyCodes: row.subspecialtyCodes ?? [],
        modalityCodes: row.modalityCodes ?? [],
        tenantId: row.tenantId,
        openCases,
        signedToday: signed.get(row.userId) ?? 0,
        maxQueueSize: row.maxQueueSize ?? 5,
        declaredState: row.state ?? 'offline',
        declaredSince: row.stateSince,
        lastSeenAt: row.lastSeenAt,
        color: presence.color,
        code: presence.code,
        label: PRESENCE_LABEL[presence.code],
        routable: presence.routable,
        sinceSeenSeconds: presence.sinceSeenSeconds,
        onShift: window ? { kind: window.kind, startsAt: window.startsAt, endsAt: window.endsAt } : null,
      };
    });

    // Sorted so the routable people are at the top without the operator having to
    // scan for green: a board read at 2 a.m. has to answer "who do I call" in one look.
    panel.sort((a, b) => (a.color === b.color
      ? a.name.localeCompare(b.name)
      : ['green', 'amber', 'red'].indexOf(a.color) - ['green', 'amber', 'red'].indexOf(b.color)));

    res.json({
      ok: true, generatedAt: now,
      counts: {
        green: panel.filter((p) => p.color === 'green').length,
        amber: panel.filter((p) => p.color === 'amber').length,
        red: panel.filter((p) => p.color === 'red').length,
      },
      panel,
    });
  }));

  return r;
}
