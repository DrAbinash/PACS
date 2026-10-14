import { eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { appendAudit, clinicianProfiles, users } from '@telrad/db';
import { hashPassword } from '@telrad/shared';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { requireAuth, requireRole, scopeTenant, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const ROLES = ['owner', 'console', 'center_staff', 'radiologist', 'reviewer', 'typist'] as const;
const STATUSES = ['invited', 'active', 'locked', 'disabled'] as const;
const GRADES = ['junior', 'senior', 'chief'] as const;
const CLINICIAN_ROLES = ['radiologist', 'reviewer'];

// Operators need a way to provision and disable the humans who touch the platform.
// Every field this surface writes is also an audit event, because a disabled reader
// who is still routed to is a patient-safety incident waiting to happen.
export function usersRouter(db: Db): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get('/users', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return;
    const p = req.principal!;
    const scope = scopeTenant(p);

    const rows = await db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      tenantId: users.tenantId,
      status: users.status,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
      totpEnabled: users.totpEnabled,
      createdAt: users.createdAt,
    }).from(users)
      .where(scope === null ? undefined : eq(users.tenantId, scope))
      .orderBy(users.id);

    const userIds = rows.map((r) => r.id);
    const profiles = userIds.length === 0 ? [] : await db.select().from(clinicianProfiles)
      .where(sql`${clinicianProfiles.userId} = any(${userIds}::int[])`);
    const byUser = new Map(profiles.map((p) => [p.userId, p]));

    res.json({
      ok: true,
      users: rows.map((r) => ({ ...r, clinician: byUser.get(r.id) ?? null })),
    });
  }));

  r.post('/users', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return;
    const p = req.principal!;
    const scope = scopeTenant(p);
    const body = req.body ?? {};

    const email = String(body.email ?? '').trim().toLowerCase();
    const displayName = String(body.displayName ?? '').trim();
    const role = String(body.role ?? '');
    if (!email.includes('@') || !displayName || !ROLES.includes(role as typeof ROLES[number])) {
      return res.status(422).json({ ok: false, error: 'email, displayName and a valid role are required' });
    }

    let tenantId: number | null = body.tenantId === undefined || body.tenantId === null
      ? null
      : Number(body.tenantId);
    if (tenantId !== null && !Number.isInteger(tenantId)) {
      return res.status(422).json({ ok: false, error: 'tenantId must be an integer or null' });
    }
    if (scope !== null && tenantId !== scope) {
      return res.status(403).json({ ok: false, error: 'cannot create user outside your tenant' });
    }
    if (role === 'owner' && (p.role !== 'owner' || scope !== null)) {
      return res.status(403).json({ ok: false, error: 'only a platform owner can create another owner' });
    }

    const clash = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from telrad.users where lower(email) = ${email}`,
    );
    if (clash[0]?.n !== '0') {
      return res.status(409).json({ ok: false, error: 'email already exists' });
    }

    // A generated password travels back over TLS exactly once. The operator hands it
    // to the user out-of-band; the hash stored here is the only copy that survives.
    const tempPassword = randomBytes(12).toString('base64url');

    const [user] = await db.insert(users).values({
      email,
      displayName,
      role: role as typeof ROLES[number],
      tenantId,
      passwordHash: await hashPassword(tempPassword),
      passwordAlgo: 'scrypt',
      status: 'invited',
    }).returning();
    if (!user) return res.status(500).json({ ok: false, error: 'insert failed' });

    let clinician = null;
    if (CLINICIAN_ROLES.includes(role)) {
      const c = body.clinician ?? {};
      const council = String(c.registrationCouncil ?? '').trim();
      const regNo = String(c.registrationNumber ?? '').trim();
      if (!council || !regNo) {
        return res.status(422).json({
          ok: false, error: 'clinician.registrationCouncil and registrationNumber are required for readers',
        });
      }
      const parseList = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
        if (typeof v === 'string') return v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        return [];
      };
      const subs = parseList(c.subspecialtyCodes);
      const mods = parseList(c.modalityCodes);
      const grade = String(c.grade ?? 'junior');
      if (!GRADES.includes(grade as typeof GRADES[number])) {
        return res.status(422).json({ ok: false, error: 'clinician.grade must be junior/senior/chief' });
      }
      const maxQueue = c.maxQueueSize === undefined ? 5 : Number(c.maxQueueSize);
      if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 50) {
        return res.status(422).json({ ok: false, error: 'clinician.maxQueueSize must be 1..50' });
      }
      [clinician] = await db.insert(clinicianProfiles).values({
        userId: user.id,
        registrationCouncil: council,
        registrationNumber: regNo,
        stateCodes: parseList(c.stateCodes),
        grade: grade as typeof GRADES[number],
        subspecialtyCodes: subs,
        modalityCodes: mods,
        maxQueueSize: maxQueue,
        acceptsNight: Boolean(c.acceptsNight),
      }).returning();
    }

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'user.create', entity: 'users', entityId: String(user.id),
      detail: { email, role, tenantId, hasClinician: clinician !== null },
    });

    res.status(201).json({ ok: true, user: { ...user, clinician }, tempPassword });
  }));

  r.patch('/users/:id', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return;
    const p = req.principal!;
    const scope = scopeTenant(p);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });

    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (scope !== null && target.tenantId !== scope) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (target.role === 'owner' && p.role !== 'owner') {
      return res.status(403).json({ ok: false, error: 'only an owner can modify another owner' });
    }

    const body = req.body ?? {};
    const changes: Record<string, unknown> = {};
    if (body.displayName !== undefined) {
      const s = String(body.displayName).trim();
      if (!s) return res.status(422).json({ ok: false, error: 'displayName cannot be empty' });
      changes.displayName = s;
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role as typeof ROLES[number])) {
        return res.status(422).json({ ok: false, error: 'invalid role' });
      }
      if (target.role === 'owner' && body.role !== 'owner') {
        if (p.role !== 'owner') return res.status(403).json({ ok: false, error: 'only an owner can demote an owner' });
        const [ownerCount] = await db.execute<{ n: string }>(
          sql`select count(*)::text as n from telrad.users where role = 'owner' and status = 'active'`,
        );
        if (ownerCount?.n === '1') {
          return res.status(409).json({ ok: false, error: 'cannot demote the last active owner' });
        }
      }
      changes.role = body.role;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as typeof STATUSES[number])) {
        return res.status(422).json({ ok: false, error: 'invalid status' });
      }
      changes.status = body.status;
    }
    if (body.tenantId !== undefined) {
      const t = body.tenantId === null ? null : Number(body.tenantId);
      if (t !== null && !Number.isInteger(t)) {
        return res.status(422).json({ ok: false, error: 'tenantId must be integer or null' });
      }
      if (scope !== null && t !== scope) {
        return res.status(403).json({ ok: false, error: 'cannot move user outside your tenant' });
      }
      changes.tenantId = t;
    }

    if (Object.keys(changes).length === 0) {
      return res.status(422).json({ ok: false, error: 'no user fields to update' });
    }
    await db.update(users).set(changes).where(eq(users.id, id));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'user.update', entity: 'users', entityId: String(id),
      detail: { changes, prior: { role: target.role, status: target.status, tenantId: target.tenantId } },
    });

    const [updated] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    res.json({ ok: true, user: updated });
  }));

  r.post('/users/:id/reset-password', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, ['owner', 'console'], res)) return;
    const p = req.principal!;
    const scope = scopeTenant(p);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });

    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (scope !== null && target.tenantId !== scope) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (target.role === 'owner' && p.role !== 'owner') {
      return res.status(403).json({ ok: false, error: 'only an owner can reset an owner password' });
    }

    const tempPassword = randomBytes(12).toString('base64url');
    await db.update(users).set({
      passwordHash: await hashPassword(tempPassword),
      passwordAlgo: 'scrypt',
      failedAttempts: 0,
      lockedUntil: null,
    }).where(eq(users.id, id));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'user.reset_password', entity: 'users', entityId: String(id),
      detail: { targetEmail: target.email },
    });

    res.json({ ok: true, tempPassword });
  }));

  return r;
}
