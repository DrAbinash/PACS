import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  apiTokens,
  appendAudit,
  tenantSites,
} from '@telrad/db';
import { cleanText, hashToken, newToken } from '@telrad/shared';
import { Router } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

export function sitesRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/sites', '/tokens'], requireAuth(db)));

  // Site registration and credential issuing is an operator action. A center must
  // never be able to mint a token that writes into another center's queue.
  r.use(scoped(['/sites', '/tokens'],
    (req: Ctx, res, next) => (requireRole(req.principal, ['owner', 'console'], res) ? next() : undefined)));

  r.get('/sites', ah(async (req: Ctx, res) => {
    const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
    const rows = await db.select().from(tenantSites)
      .where(tenantId === null ? sql`true` : eq(tenantSites.tenantId, tenantId))
      .orderBy(desc(tenantSites.createdAt)).limit(200);
    res.json({ ok: true, sites: rows.map((s) => ({ ...s, allowedCidrs: s.allowedCidrs })) });
  }));

  r.post('/sites', ah(async (req: Ctx, res) => {
    const tenantId = Number(req.body?.tenantId);
    const name = cleanText(req.body?.name, 120);
    // The value stored here is compared against Orthanc's RemoteAET — the AE title
    // of the machine that actually sent the study — not a tag inside the file.
    const aeTitle = cleanText(req.body?.aeTitle, 64).replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
    if (!Number.isInteger(tenantId) || !name || !aeTitle) {
      return res.status(422).json({ ok: false, error: 'tenant_id, name and ae_title are required' });
    }
    const clash = await db.select({ id: tenantSites.id }).from(tenantSites)
      .where(sql`lower(${tenantSites.aeTitle}) = lower(${aeTitle})`).limit(1);
    if (clash[0]) return res.status(409).json({ ok: false, error: 'ae_title_taken' });

    const cidrs = Array.isArray(req.body?.allowedCidrs)
      ? (req.body.allowedCidrs as unknown[]).map((c) => cleanText(c, 48)).filter((c) => /^[0-9a-fA-F:./]+$/.test(c))
      : [];

    const [row] = await db.insert(tenantSites).values({ tenantId, name, aeTitle, allowedCidrs: cidrs }).returning();
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'site.created', entity: 'tenant_sites', entityId: String(row!.id), detail: { aeTitle, cidrs },
    });
    res.status(201).json({ ok: true, site: row });
  }));

  r.post('/sites/:id/tokens', ah(async (req: Ctx, res) => {
    const siteId = Number(req.params.id);
    const [site] = await db.select().from(tenantSites).where(eq(tenantSites.id, siteId)).limit(1);
    if (!site) return res.status(404).json({ ok: false, error: 'not_found' });

    const label = cleanText(req.body?.label ?? 'agent', 80);
    const ttlDays = Math.min(Number(req.body?.ttlDays ?? 365) || 365, 730);
    const token = newToken(32);

    await db.insert(apiTokens).values({
      tenantId: site.tenantId,
      siteId: site.id,
      label,
      tokenHash: hashToken(token),
      // The prefix is what an operator recognises in a listing; the value that
      // matters is only ever stored hashed, so a database dump is not a key dump.
      tokenPrefix: token.slice(0, 8),
      scopes: ['upload'],
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    });

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: site.tenantId,
      action: 'token.issued', entity: 'api_tokens', entityId: `${site.id}:${label}`, detail: { prefix: token.slice(0, 8), ttlDays },
    });
    res.status(201).json({ ok: true, token, note: 'shown once; store it in the agent config now' });
  }));

  r.get('/sites/:id/tokens', ah(async (req: Ctx, res) => {
    const siteId = Number(req.params.id);
    const rows = await db.select({
      id: apiTokens.id, label: apiTokens.label, tokenPrefix: apiTokens.tokenPrefix,
      createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt,
    }).from(apiTokens).where(eq(apiTokens.siteId, siteId)).orderBy(desc(apiTokens.createdAt)).limit(50);
    res.json({ ok: true, tokens: rows });
  }));

  r.post('/tokens/:id/revoke', ah(async (req: Ctx, res) => {
    const id = Number(req.params.id);
    const [tok] = await db.select({ id: apiTokens.id, tenantId: apiTokens.tenantId, label: apiTokens.label })
      .from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
    if (!tok) return res.status(404).json({ ok: false, error: 'not_found' });
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: tok.tenantId,
      action: 'token.revoked', entity: 'api_tokens', entityId: String(id), detail: { label: tok.label },
    });
    res.json({ ok: true, id });
  }));

  return r;
}
