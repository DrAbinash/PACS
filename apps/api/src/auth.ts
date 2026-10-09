import { sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { hashToken } from '@telrad/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ah } from './handler.js';

export const COOKIE = 'telrad_session';

export type Principal = { userId: number; role: string; tenantId: number | null };
export type AgentPrincipal = { tenantId: number; siteId: number | null; tokenId: number; label: string };
export type Ctx = Request & { principal?: Principal; agent?: AgentPrincipal };

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function loadPrincipal(db: Db, token: string): Promise<Principal | null> {
  const rows = await db.execute<{ user_id: number; role: string; tenant_id: number | null }>(sql`
    select u.id as user_id, u.role, u.tenant_id
      from telrad.sessions s
      join telrad.users u on u.id = s.user_id
     where s.token_hash = ${hashToken(token)}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.status = 'active'
     limit 1`);
  const found = rows[0];
  if (!found) return null;
  return { userId: found.user_id, role: found.role, tenantId: found.tenant_id };
}

// Site-scoped machine credential. The row carries the tenant and site, so an agent
// installed at one center cannot write into another center's queue even if the
// token leaks.
export async function loadAgent(db: Db, bearer: string): Promise<AgentPrincipal | null> {
  const rows = await db.execute<{ id: number; tenant_id: number; site_id: number | null; label: string }>(sql`
    select t.id, t.tenant_id, t.site_id, t.label
      from telrad.api_tokens t
      join telrad.tenants tn on tn.id = t.tenant_id
     where t.token_hash = ${hashToken(bearer)}
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())
       and tn.status in ('trial', 'active')
     limit 1`);
  const found = rows[0];
  if (!found) return null;
  await db.execute(sql`update telrad.api_tokens set last_used_at = now() where id = ${found.id}`);
  return { tokenId: found.id, tenantId: found.tenant_id, siteId: found.site_id, label: found.label };
}

export function requireAuth(db: Db): RequestHandler {
  return ah(async (req: Ctx, res: Response, next: NextFunction) => {
    const token = readCookie(req, COOKIE);
    if (!token) return res.status(401).json({ ok: false, error: 'unauthenticated' });
    const principal = await loadPrincipal(db, token);
    if (!principal) return res.status(401).json({ ok: false, error: 'unauthenticated' });
    req.principal = principal;
    next();
  });
}

// Uploads accept either a session (a person at the desk using the browser) or a
// site token (the agent on the modality PC). Both resolve to a tenant and a site,
// and the code downstream does not care which door it came through.
export function requireUploader(db: Db): RequestHandler {
  return ah(async (req: Ctx, res: Response, next: NextFunction) => {
    const bearer = bearerOf(req);
    if (bearer) {
      const agent = await loadAgent(db, bearer);
      if (agent) {
        req.agent = agent;
        // A token bound to one site must not be able to name another.
        if (req.query.site_id && Number(req.query.site_id) !== agent.siteId) {
          return res.status(403).json({ ok: false, error: 'token_site_mismatch' });
        }
        return next();
      }
    }
    const cookie = readCookie(req, COOKIE);
    if (cookie) {
      const principal = await loadPrincipal(db, cookie);
      if (principal && (principal.role === 'center_staff' || principal.role === 'owner' || principal.role === 'console')) {
        req.principal = principal;
        return next();
      }
    }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  });
}

export function bearerOf(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

// Tenant isolation is applied here rather than trusted to caller-supplied filters:
// a center role can only ever see its own tenant's rows.
export function scopeTenant(p: Principal): number | null {
  return p.role === 'owner' || p.role === 'console' ? null : p.tenantId;
}

// A router mounted at '/v1' runs its `use` guards for every '/v1/...' request, not
// only for the routes it actually declares. Two real defects came from that: an
// agent token was refused by a session guard on another router, and a radiologist
// polling /v1/presence got 403 from the sites router's owner-only check. Reordering
// mounts hides the problem until the next router; scoping the guard to the paths the
// router owns removes it.
export function scoped(prefixes: string[], guard: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const owned = prefixes.some((p) => req.path === p || req.path.startsWith(p + '/'));
    return owned ? guard(req, res, next) : next();
  };
}

export function requireRole(p: Principal | undefined, roles: string[], res: Response): boolean {
  if (!p) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return false; }
  if (!roles.includes(p.role)) { res.status(403).json({ ok: false, error: 'forbidden' }); return false; }
  return true;
}
