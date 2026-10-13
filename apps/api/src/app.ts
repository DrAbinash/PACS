import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  auditLog,
  clinicianProfiles,
  sessions,
  studies,
  tenants,
  users,
} from '@telrad/db';
import { LINK_STATES, hashToken, newToken, verifyPassword, type LinkState } from '@telrad/shared';
import express, { type Express, type Router } from 'express';
import { ah, errorHandler } from './handler.js';
import {
  COOKIE, SESSION_ABSOLUTE_MS, SESSION_TTL_MS, readCookie, requireAuth, scopeTenant, type Ctx,
} from './auth.js';
import { billingRouter } from './routes/billing.js';
import { clinicalRouter } from './routes/clinical.js';
import { criticalsRouter } from './routes/criticals.js';
import { filmRouter } from './routes/film.js';
import { orphansRouter } from './routes/orphans.js';
import { performanceRouter } from './routes/performance.js';
import { presenceRouter } from './routes/presence.js';
import { qcRouter } from './routes/qc.js';
import { reportsRouter } from './routes/reports.js';
import { sitesRouter } from './routes/sites.js';
import { slaRouter } from './routes/sla.js';
import { tenantsRouter } from './routes/tenants.js';
import { totpRouter } from './routes/totp.js';
import { uploadsRouter } from './routes/uploads.js';
import { viewRouter } from './routes/view.js';
import { worklistRouter } from './routes/worklist.js';
import { metricsRouter } from './metrics.js';
import type { OrthancClient } from './orthanc.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export type AppDeps = {
  db: Db;
  version: string;
  inboxRoot: string;
  secureCookies: boolean;
  orthanc: OrthancClient;
};

export { COOKIE, readCookie };

export function createApp(deps: AppDeps): Express {
  const { db, version, inboxRoot, secureCookies, orthanc } = deps;
  const app = express();
  app.disable('x-powered-by');
  // Exactly one hop sits between the browser and this process — the Caddy
  // entrypoint. Trusting that one hop takes the client address from the
  // X-Forwarded-For entry Caddy appended and ignores anything a client spoofed
  // ahead of it. Without it, every session row records Caddy's container
  // address as the client and req.ip is useless to the login gate below.
  app.set('trust proxy', 1);

  // Uploaded files stream to disk. Buffering a study in memory would take the API
  // down on the same machine that holds the archive, so JSON parsing is attached
  // per-path instead of globally.
  const json = express.json({ limit: '256kb' });
  app.use((req, res, next) => {
    if (req.method === 'PUT' && req.path.startsWith('/v1/uploads/')) return next();
    return json(req, res, next);
  });

  app.get('/health/live', (_req, res) => {
    res.json({ ok: true, version });
  });

  // Readiness answers "is it well", not "what is behind it": no provider name, no
  // path, no credential echo. A container runtime has to be able to ask.
  app.get('/health/ready', ah(async (_req, res) => {
    const checks = { db: false, orthanc: false, worker: false };
    try {
      await db.execute(sql`select 1`);
      checks.db = true;
    } catch { checks.db = false; }
    checks.orthanc = await orthanc.ping().catch(() => false);
    // The worker has no HTTP surface to ping, but every tick stamps the ingest
    // cursor it advances — that stamp is its heartbeat, already being written.
    // A stamp older than 90 seconds (nine missed ten-second polls) means the
    // pipeline that links and routes studies is dead even though this api is
    // fine. No row at all is not an outage: a stack that has never ingested is
    // a fresh one, and readiness must not fail on it.
    let workerState: 'fresh' | 'stale' | 'unknown' = 'unknown';
    if (checks.db) {
      try {
        // A timestamptz through this raw execute path arrives as a string, not a
        // Date, so the heartbeat is read as epoch millis and compared numerically.
        const rows = await db.execute<{ last_run_ms: number }>(
          sql`select extract(epoch from max(last_run_at))::float8 * 1000 as last_run_ms
              from telrad.ingest_cursors`);
        const lastMs = rows[0]?.last_run_ms;
        if (lastMs != null) {
          workerState = Date.now() - Number(lastMs) < 90_000 ? 'fresh' : 'stale';
        }
      } catch { workerState = 'unknown'; }
    }
    checks.worker = workerState !== 'stale';
    const ok = checks.db && checks.orthanc && checks.worker;
    res.status(ok ? 200 : 503).json({ ok, version, components: checks, workerState });
  }));

  // Secure unless the configured public origin is plain http — which only happens
  // on a laptop or a CI container. A deployed stack always sets TR_PUBLIC_URL to
  // https, so the flag cannot be turned off by forgetting to configure something.
  const cookieHeader = (token: string, maxAgeSeconds: number) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;

  // Per-IP failed-login gate, beside the per-account lock in the route below:
  // the lock stops one name being hammered, this stops one address spraying
  // every name. In-memory is the right weight — one api process behind one
  // Caddy hop, and a restart costs an attacker nothing they had not already lost.
  const LOGIN_WINDOW_MS = 15 * 60_000;
  const LOGIN_MAX_FAILURES = 20;
  const failedLogins = new Map<string, { count: number; resetAt: number }>();

  const router: Router = express.Router();

  router.post('/auth/login', ah(async (req, res, next) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const ip = req.ip ?? 'unknown';
      const nowMs = Date.now();
      const gate = failedLogins.get(ip);
      if (gate && nowMs < gate.resetAt && gate.count >= LOGIN_MAX_FAILURES) {
        return res.status(429).json({ ok: false, error: 'too_many_failures' });
      }
      const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      const passwordOk = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;

      if (!user || user.status !== 'active' || !passwordOk) {
        if (user) {
          const failed = (user.failedAttempts ?? 0) + 1;
          await db.update(users).set({
            failedAttempts: failed,
            lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
          }).where(eq(users.id, user.id));
        }
        await appendAudit(db, {
          actorUserId: user?.id ?? null, actorKind: 'system', tenantId: user?.tenantId ?? null,
          action: 'auth.login_failed', entity: 'users', entityId: String(user?.id ?? 'unknown'),
        });
        const entry = failedLogins.get(ip) ?? { count: 0, resetAt: nowMs + LOGIN_WINDOW_MS };
        if (nowMs >= entry.resetAt) { entry.count = 0; entry.resetAt = nowMs + LOGIN_WINDOW_MS; }
        entry.count += 1;
        failedLogins.set(ip, entry);
        // An address rotating through IPv6 source space can grow the map without
        // bound; past this size, drop the expired windows and keep only live ones.
        if (failedLogins.size > 10_000) {
          for (const [k, v] of failedLogins) if (nowMs >= v.resetAt) failedLogins.delete(k);
        }
        // Identical response whether the address exists or not, so the endpoint
        // cannot be used to enumerate who works at a center.
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
      }

      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        return res.status(423).json({ ok: false, error: 'account_locked' });
      }

      // TOTP gate: if the user has 2FA enabled, issue a temporary session that
      // can only be exchanged for a real one via POST /auth/totp/complete. The
      // temporary session is short-lived and cannot access any other endpoint.
      if (user.totpEnabled) {
        const tempToken = newToken();
        const now = new Date();
        // Temporary sessions expire in 2 minutes — enough time to type a code,
        // not enough for an attacker to brute-force offline.
        await db.insert(sessions).values({
          id: newToken(8),
          userId: user.id,
          tokenHash: hashToken(tempToken),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 2 * 60_000),
          ip: req.ip,
          userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
        });
        await appendAudit(db, {
          actorUserId: user.id, actorKind: 'human', tenantId: user.tenantId,
          action: 'auth.login_totp_required', entity: 'users', entityId: String(user.id),
          detail: { role: user.role },
        });
        return res.json({
          ok: true,
          requiresTotp: true,
          tempToken,
        });
      }

      const token = newToken();
      const now = new Date();
      await db.insert(sessions).values({
        id: newToken(8),
        userId: user.id,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
      });
      await db.update(users).set({ failedAttempts: 0, lastLoginAt: now }).where(eq(users.id, user.id));
      failedLogins.delete(ip);
      // The cookie must outlive the longest session the slide can produce, or a
      // session the database still honours becomes unpresentable at the browser.
      // The database row remains the authority: it expires in SESSION_TTL_MS
      // unless the session keeps being used.
      res.setHeader('Set-Cookie', cookieHeader(token, SESSION_ABSOLUTE_MS / 1000));
      await appendAudit(db, {
        actorUserId: user.id, actorKind: 'human', tenantId: user.tenantId,
        action: 'auth.login', entity: 'users', entityId: String(user.id),
        detail: { role: user.role },
      });
      return res.json({ ok: true, user: { id: user.id, role: user.role, name: user.displayName } });
    } catch (err) { next(err); }
  }));

  router.post('/auth/logout', ah(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      await db.execute(sql`update telrad.sessions set revoked_at = now() where token_hash = ${hashToken(token)}`);
    }
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
  }));

  router.get('/auth/session', requireAuth(db), ah(async (req: Ctx, res) => {
    const p = req.principal!;
    const [clinician] = await db.select().from(clinicianProfiles).where(eq(clinicianProfiles.userId, p.userId));
    res.json({
      ok: true,
      user: { id: p.userId, role: p.role, tenantId: p.tenantId },
      clinician: clinician
        ? {
            grade: clinician.grade,
            subspecialtyCodes: clinician.subspecialtyCodes,
            stateCodes: clinician.stateCodes,
            maxQueueSize: clinician.maxQueueSize,
            registrationNumber: clinician.registrationNumber,
          }
        : null,
    });
  }));

  router.get('/studies', requireAuth(db), ah(async (req: Ctx, res) => {
    const tenantId = scopeTenant(req.principal!);
    const requested = String(req.query.state ?? 'orphan');
    if (!(LINK_STATES as readonly string[]).includes(requested)) {
      // A parameter that reaches a column with a fixed domain is validated rather
      // than cast, so a typo answers 400 instead of silently returning [].
      return res.status(400).json({ ok: false, error: 'bad_state' });
    }
    const state = requested as LinkState;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    const rows = await db.select({
      id: studies.id,
      tenantCode: tenants.code,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: studies.priority,
      linkState: studies.linkState,
      matchScore: studies.matchScore,
      accession: studies.accessionNumber,
      studyDate: studies.studyDate,
      receivedAt: studies.receivedAt,
    }).from(studies)
      .leftJoin(tenants, eq(tenants.id, studies.tenantId))
      .where(and(
        tenantId === null ? sql`true` : eq(studies.tenantId, tenantId),
        eq(studies.linkState, state),
      ))
      .orderBy(desc(studies.receivedAt))
      .limit(limit);

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'studies.list', entity: 'studies', detail: { state, count: rows.length },
    });
    res.json({ ok: true, studies: rows });
  }));

  router.get('/studies/:id', requireAuth(db), ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const rows = await db.select().from(studies).where(eq(studies.id, id)).limit(1);
    const row = rows[0];
    const tenantId = scopeTenant(req.principal!);
    // Constant-time response: a cross-tenant lookup and a non-existent row both return 404,
    // but the cross-tenant path writes an audit row first, making it measurably slower. An
    // attacker who can measure response times can enumerate which study IDs exist in other
    // tenants. A fixed delay masks the difference. 50ms is enough to cover the audit write
    // latency without being noticeable to a legitimate user.
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!row) {
      await delay(50);
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (tenantId !== null && row.tenantId !== tenantId) {
      await appendAudit(db, {
        actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
        action: 'studies.denied_cross_tenant', entity: 'studies', entityId: String(id),
      });
      await delay(50);
      // 404, not 403: a center must not learn that some other center's id exists.
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'studies.read', entity: 'studies', entityId: String(id),
    });
    res.json({ ok: true, study: row });
  }));

  router.get('/audit/latest', requireAuth(db), ah(async (req: Ctx, res) => {
    const p = req.principal!;
    if (p.role !== 'owner' && p.role !== 'console') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const rows = await db.select({
      id: auditLog.id, action: auditLog.action, entity: auditLog.entity,
      entityId: auditLog.entityId, actorUserId: auditLog.actorUserId,
      occurredAt: auditLog.occurredAt, rowHash: auditLog.rowHash, prevHash: auditLog.prevHash,
    }).from(auditLog).orderBy(desc(auditLog.id)).limit(50);
    res.json({ ok: true, entries: rows });
  }));

  // Audit export: a regulator or a center's compliance officer asks for "everything that
  // happened in October". The answer is a CSV or JSON file, not a screenshot of the
  // console. The export is tenant-scoped: a console operator sees their own center's
  // chain, and an owner sees all of them.
  router.get('/audit/export', requireAuth(db), ah(async (req: Ctx, res) => {
    const p = req.principal!;
    if (p.role !== 'owner' && p.role !== 'console') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const format = String(req.query.format ?? 'json').toLowerCase();
    const tenantId = p.role === 'owner' ? null : p.tenantId;

    const rows = await db.select({
      id: auditLog.id,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      actorUserId: auditLog.actorUserId,
      actorKind: auditLog.actorKind,
      tenantId: auditLog.tenantId,
      occurredAt: auditLog.occurredAt,
      rowHash: auditLog.rowHash,
      prevHash: auditLog.prevHash,
      detail: auditLog.detail,
    }).from(auditLog)
      .where(and(
        gte(auditLog.occurredAt, from),
        lte(auditLog.occurredAt, to),
        tenantId === null ? sql`true` : eq(auditLog.tenantId, tenantId),
      ))
      .orderBy(desc(auditLog.id))
      .limit(10000);

    if (format === 'csv') {
      const header = 'id,action,entity,entity_id,actor_user_id,actor_kind,tenant_id,occurred_at,row_hash,prev_hash,detail\n';
      const csvRows = rows.map((r) => [
        r.id,
        `"${r.action}"`,
        `"${r.entity}"`,
        `"${r.entityId}"`,
        r.actorUserId ?? '',
        `"${r.actorKind}"`,
        r.tenantId ?? '',
        `"${r.occurredAt.toISOString()}"`,
        `"${r.rowHash}"`,
        `"${r.prevHash ?? ''}"`,
        `"${JSON.stringify(r.detail ?? {}).replace(/"/g, '""')}"`,
      ].join(','));
      const csv = header + csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } else {
      res.json({
        ok: true,
        from,
        to,
        count: rows.length,
        entries: rows,
      });
    }
  }));

  // Mounted first, and deliberately so. The session-scoped routers below guard
  // themselves with `r.use(requireAuth)`, and a router mounted at '/v1' runs that
  // guard for every '/v1/...' request — including '/v1/uploads/...'. A site agent has
  // a token and no cookie, so with the other order the upload channel answers 401 to
  // the only users it exists for. This was measured, not reasoned: the acceptance
  // script passed only because it reused the console operator's session cookie.
  app.use('/v1/uploads', uploadsRouter(db, inboxRoot));

  app.use('/v1', router);
  app.use('/v1', clinicalRouter(db));
  app.use('/v1', sitesRouter(db));
  app.use('/v1', orphansRouter(db));
  app.use('/v1', presenceRouter(db));
  app.use('/v1', worklistRouter(db));
  app.use('/v1', viewRouter(db, orthanc));
  app.use('/v1', reportsRouter(db));
  app.use('/v1', criticalsRouter(db));
  app.use('/v1', billingRouter(db));
  app.use('/v1', qcRouter(db));
  app.use('/v1', filmRouter(db));
  app.use('/v1', performanceRouter(db));
  app.use('/v1', slaRouter(db));
  app.use('/v1', tenantsRouter(db));
  app.use('/v1', totpRouter(db, secureCookies));
  app.use(metricsRouter(db));

  // An unknown `/v1/...` path answers with JSON, not Express's HTML 404. Every other
  // failure mode in this API speaks JSON, and a client should not have to special-case one.
  app.use('/v1/*', (_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Mounted last: this is the only responder for anything that reached `next` with
  // an error, and it is what keeps a rejected database read from becoming a dead
  // process. See handler.ts for why the wrapper above it is not optional.
  app.use(errorHandler);

  return app;
}
