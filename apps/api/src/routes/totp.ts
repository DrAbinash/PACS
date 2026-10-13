import { eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { appendAudit, sessions, users } from '@telrad/db';
import { hashToken, newToken, verifyPassword } from '@telrad/shared';
import { Router } from 'express';
import * as OTPAuth from 'otpauth';
import { COOKIE, SESSION_ABSOLUTE_MS, SESSION_TTL_MS, requireAuth, requireRole, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const OWNER_ROLES = ['owner'];

function cookieHeader(token: string, maxAgeSeconds: number, secureCookies: boolean) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;
}

function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    codes.push(code.slice(0, 8));
  }
  return codes;
}

export function totpRouter(db: Db, secureCookies: boolean): Router {
  const r = Router();

  // Begin enrollment: generate a TOTP secret and return the provisioning URI
  // for QR code rendering. The secret is stored but not yet enabled — the user
  // must verify a code before 2FA becomes active.
  r.post('/auth/totp/setup', requireAuth(db), ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OWNER_ROLES, res)) return;
    const p = req.principal!;

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Telrad',
      label: p.userId.toString(),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const secretBase32 = secret.base32;
    const otpauthUri = totp.toString();

    // Store the secret but keep totp_enabled = false until verification.
    await db.update(users)
      .set({ totpSecret: secretBase32 })
      .where(eq(users.id, p.userId));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'totp.setup', entity: 'users', entityId: String(p.userId),
    });

    res.json({ ok: true, secret: secretBase32, otpauthUri });
  }));

  // Verify the TOTP code and enable 2FA. Generates backup codes that are
  // returned once and never shown again.
  r.post('/auth/totp/verify', requireAuth(db), ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OWNER_ROLES, res)) return;
    const p = req.principal!;
    const code = String(req.body?.code ?? '').trim();

    const [user] = await db.select().from(users).where(eq(users.id, p.userId)).limit(1);
    if (!user?.totpSecret) {
      return res.status(400).json({ ok: false, error: 'totp_not_setup' });
    }

    const secret = OTPAuth.Secret.fromBase32(user.totpSecret);
    const totp = new OTPAuth.TOTP({
      issuer: 'Telrad',
      label: p.userId.toString(),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return res.status(400).json({ ok: false, error: 'invalid_code' });
    }

    const backupCodes = generateBackupCodes(8);

    await db.update(users)
      .set({
        totpEnabled: true,
        totpBackupCodes: backupCodes,
      })
      .where(eq(users.id, p.userId));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'totp.enabled', entity: 'users', entityId: String(p.userId),
    });

    res.json({ ok: true, backupCodes });
  }));

  // Disable 2FA. Requires password confirmation to prevent a session hijacker
  // from turning off the second factor.
  r.post('/auth/totp/disable', requireAuth(db), ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OWNER_ROLES, res)) return;
    const p = req.principal!;
    const password = String(req.body?.password ?? '');

    const [user] = await db.select().from(users).where(eq(users.id, p.userId)).limit(1);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const passwordOk = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
    if (!passwordOk) {
      return res.status(401).json({ ok: false, error: 'invalid_password' });
    }

    await db.update(users)
      .set({
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodes: null,
      })
      .where(eq(users.id, p.userId));

    await appendAudit(db, {
      actorUserId: p.userId, actorKind: 'human', tenantId: p.tenantId,
      action: 'totp.disabled', entity: 'users', entityId: String(p.userId),
    });

    res.json({ ok: true });
  }));

  // Complete the second factor after initial login. The login endpoint returns
  // a temporary token when TOTP is enabled; this endpoint exchanges it for a
  // real session after verifying the code.
  r.post('/auth/totp/complete', ah(async (req: Ctx, res) => {
    const tempToken = String(req.body?.tempToken ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const useBackup = req.body?.useBackup === true;

    if (!tempToken) {
      return res.status(400).json({ ok: false, error: 'missing_temp_token' });
    }

    // Look up the temporary session.
    const rows = await db.execute<{
      session_id: string; user_id: number; role: string; tenant_id: number | null;
      totp_secret: string | null; totp_enabled: boolean; totp_backup_codes: string[] | null;
    }>(sql`
      select s.id as session_id, u.id as user_id, u.role, u.tenant_id,
             u.totp_secret, u.totp_enabled, u.totp_backup_codes
        from telrad.sessions s
        join telrad.users u on u.id = s.user_id
       where s.token_hash = ${hashToken(tempToken)}
         and s.revoked_at is null
         and s.expires_at > now()
       limit 1`);

    const found = rows[0];
    if (!found || !found.totp_enabled || !found.totp_secret) {
      return res.status(401).json({ ok: false, error: 'invalid_temp_session' });
    }

    let codeValid = false;

    if (useBackup) {
      // Check backup codes.
      const backupCodes = found.totp_backup_codes ?? [];
      const idx = backupCodes.indexOf(code.toLowerCase());
      if (idx >= 0) {
        codeValid = true;
        // Remove the used backup code.
        const remaining = [...backupCodes];
        remaining.splice(idx, 1);
        await db.update(users)
          .set({ totpBackupCodes: remaining })
          .where(eq(users.id, found.user_id));
      }
    } else {
      // Check TOTP code.
      const secret = OTPAuth.Secret.fromBase32(found.totp_secret);
      const totp = new OTPAuth.TOTP({
        issuer: 'Telrad',
        label: found.user_id.toString(),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret,
      });
      const delta = totp.validate({ token: code, window: 1 });
      codeValid = delta !== null;
    }

    if (!codeValid) {
      return res.status(401).json({ ok: false, error: 'invalid_code' });
    }

    // Revoke the temporary session and issue a real one.
    await db.execute(sql`update telrad.sessions set revoked_at = now() where id = ${found.session_id}`);

    const realToken = newToken();
    const now = new Date();
    await db.insert(sessions).values({
      id: newToken(8),
      userId: found.user_id,
      tokenHash: hashToken(realToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
    });

    await appendAudit(db, {
      actorUserId: found.user_id, actorKind: 'human', tenantId: found.tenant_id,
      action: 'auth.totp_complete', entity: 'users', entityId: String(found.user_id),
      detail: { role: found.role },
    });

    res.setHeader('Set-Cookie', cookieHeader(realToken, SESSION_ABSOLUTE_MS / 1000, secureCookies));
    res.json({ ok: true, user: { id: found.user_id, role: found.role } });
  }));

  // Check TOTP status for the current user.
  r.get('/auth/totp/status', requireAuth(db), ah(async (req: Ctx, res) => {
    const p = req.principal!;
    const [user] = await db.select({
      totpEnabled: users.totpEnabled,
      backupCount: sql<number>`jsonb_array_length(coalesce(${users.totpBackupCodes}, '[]'::jsonb))`,
    }).from(users).where(eq(users.id, p.userId)).limit(1);

    res.json({
      ok: true,
      totpEnabled: user?.totpEnabled ?? false,
      backupCodeCount: user?.backupCount ?? 0,
    });
  }));

  return r;
}
