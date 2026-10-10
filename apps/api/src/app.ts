import { and, desc, eq, sql } from 'drizzle-orm';
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
import { COOKIE, readCookie, requireAuth, scopeTenant, type Ctx } from './auth.js';
import { billingRouter } from './routes/billing.js';
import { clinicalRouter } from './routes/clinical.js';
import { criticalsRouter } from './routes/criticals.js';
import { orphansRouter } from './routes/orphans.js';
import { presenceRouter } from './routes/presence.js';
import { reportsRouter } from './routes/reports.js';
import { sitesRouter } from './routes/sites.js';
import { uploadsRouter } from './routes/uploads.js';
import { viewRouter } from './routes/view.js';
import { worklistRouter } from './routes/worklist.js';
import type { OrthancClient } from './orthanc.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
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
    const checks = { db: false, orthanc: false };
    try {
      await db.execute(sql`select 1`);
      checks.db = true;
    } catch { checks.db = false; }
    checks.orthanc = await orthanc.ping().catch(() => false);
    const ok = checks.db && checks.orthanc;
    res.status(ok ? 200 : 503).json({ ok, version, components: checks });
  }));

  // Secure unless the configured public origin is plain http — which only happens
  // on a laptop or a CI container. A deployed stack always sets TR_PUBLIC_URL to
  // https, so the flag cannot be turned off by forgetting to configure something.
  const cookieHeader = (token: string, maxAgeSeconds: number) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;

  const router: Router = express.Router();

  router.post('/auth/login', ah(async (req, res, next) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
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
        // Identical response whether the address exists or not, so the endpoint
        // cannot be used to enumerate who works at a center.
        return res.status(401).json({ ok: false, error: 'invalid_credentials' });
      }

      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        return res.status(423).json({ ok: false, error: 'account_locked' });
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
      res.setHeader('Set-Cookie', cookieHeader(token, SESSION_TTL_MS / 1000));
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
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const tenantId = scopeTenant(req.principal!);
    if (tenantId !== null && row.tenantId !== tenantId) {
      await appendAudit(db, {
        actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
        action: 'studies.denied_cross_tenant', entity: 'studies', entityId: String(id),
      });
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
