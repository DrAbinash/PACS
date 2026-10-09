import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit,
  uploadBatches,
  uploadFiles,
} from '@telrad/db';
import { cleanText, LIMITS, safeFilename, sniffKind } from '@telrad/shared';
import { Router } from 'express';
import { requireUploader, type Ctx } from '../auth.js';

export type UploadCtx = { tenantId: number; siteId: number | null; channel: 'agent' | 'browser'; actorUserId: number | null };

function uploader(req: Ctx): UploadCtx | null {
  if (req.agent) return { tenantId: req.agent.tenantId, siteId: req.agent.siteId, channel: 'agent', actorUserId: null };
  if (req.principal) {
    const raw = req.principal.role === 'owner' || req.principal.role === 'console'
      ? Number(req.body?.tenantId ?? req.query.tenant_id)
      : req.principal.tenantId;
    // Number.isInteger is not a type guard, so the narrowing is written out rather
    // than assumed: a center session that names no tenant must not upload blind.
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
    const tenantId = raw;
    return { tenantId, siteId: req.body?.siteId ? Number(req.body.siteId) : null, channel: 'browser', actorUserId: req.principal.userId };
  }
  return null;
}

export function uploadsRouter(db: Db, inboxRoot: string): Router {
  const r = Router();
  r.use(requireUploader(db));

  r.post('/batches', async (req: Ctx, res) => {
    const who = uploader(req);
    if (!who) return res.status(400).json({ ok: false, error: 'tenant_required' });

    const filesExpected = Number(req.body?.filesExpected ?? 0);
    if (!Number.isInteger(filesExpected) || filesExpected < 1 || filesExpected > LIMITS.batchFilesMax) {
      return res.status(422).json({ ok: false, error: 'files_expected must be 1 to ' + LIMITS.batchFilesMax });
    }
    const bytesDeclared = Number(req.body?.bytesDeclared ?? 0);
    if (bytesDeclared > LIMITS.batchBytesMax) {
      return res.status(422).json({ ok: false, error: 'batch too large; split the study' });
    }

    const batchId = `b-${Date.now().toString(36)}-${createHash('sha1').update(`${who.tenantId}${Math.random()}`).digest('hex').slice(0, 8)}`;
    mkdirSync(path.join(inboxRoot, batchId), { recursive: true });

    await db.insert(uploadBatches).values({
      id: batchId,
      tenantId: who.tenantId,
      siteId: who.siteId,
      channel: who.channel,
      accessionHint: cleanText(req.body?.accessionHint ?? '', 64).toUpperCase() || null,
      patientHint: cleanText(req.body?.patientHint ?? '', 64) || null,
      modalityHint: cleanText(req.body?.modalityHint ?? '', 4).toUpperCase() || null,
      studyDateHint: cleanText(req.body?.studyDateHint ?? '', 8) || null,
      filesExpected,
      bytesDeclared: bytesDeclared || null,
    });

    await appendAudit(db, {
      actorUserId: who.actorUserId, actorKind: who.channel === 'agent' ? 'service' : 'human',
      tenantId: who.tenantId, action: 'upload.batch_opened', entity: 'upload_batches', entityId: batchId,
      detail: { filesExpected, channel: who.channel },
    });
    // The path an agent is told to PUT to has to be the path that is actually
    // routed, so this is written out from the route above rather than remembered.
    res.status(201).json({
      ok: true, batchId,
      putPath: `/v1/uploads/batches/${batchId}/files/:filename`,
      sealPath: `/v1/uploads/batches/${batchId}/seal`,
    });
  });

  // Raw body, streamed to disk. express.json() is deliberately not mounted on this
  // path: buffering a 400 MB MRI study in memory would take the API down on the
  // same machine that holds the archive.
  r.put('/batches/:batchId/files/:filename', async (req: Ctx, res) => {
    const who = uploader(req);
    if (!who) return res.status(400).json({ ok: false, error: 'tenant_required' });

    const batchId = cleanText(req.params.batchId, 64);
    const filename = safeFilename(req.params.filename);
    if (!filename) return res.status(422).json({ ok: false, error: 'unsafe_filename' });

    const [batch] = await db.select().from(uploadBatches).where(eq(uploadBatches.id, batchId)).limit(1);
    if (!batch) return res.status(404).json({ ok: false, error: 'batch_not_found' });
    if (batch.status !== 'open') return res.status(409).json({ ok: false, error: `batch_${batch.status}` });
    // A token issued for site A must not fill site B's batch, even if it guesses the
    // batch id — batch ids are not secrets once a center has one.
    if (who.channel === 'agent' && batch.siteId !== who.siteId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const storedPath = path.posix.join(batchId, filename);
    const abs = path.join(inboxRoot, batchId, filename);
    if (!abs.startsWith(path.join(inboxRoot, batchId))) {
      return res.status(422).json({ ok: false, error: 'unsafe_path' });
    }

    const sha = createHash('sha256');
    let received = 0;
    let tooBig = false;
    const out = createWriteStream(abs);

    // Async iteration rather than manual drain handling: backpressure comes from
    // the stream, and a hand-rolled version is where silent truncation hides.
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      received += buf.length;
      sha.update(buf);
      if (received > LIMITS.fileBytesMax) { tooBig = true; break; }
      out.write(buf);
    }

    await new Promise<void>((resolve) => { out.on('close', () => resolve()); out.end(); });

    if (tooBig) {
      await (await import('node:fs/promises')).rm(abs, { force: true });
      return res.status(413).json({ ok: false, error: 'file_too_large', limitBytes: LIMITS.fileBytesMax });
    }

    const digest = sha.digest('hex');
    const declared = cleanText(req.get('x-content-sha256') ?? '', 64).toLowerCase();
    if (declared && declared !== digest) {
      await (await import('node:fs/promises')).rm(abs, { force: true });
      return res.status(422).json({ ok: false, error: 'sha256_mismatch', expected: declared, computed: digest });
    }

    const head = new Uint8Array(await (await import('node:fs/promises')).readFile(abs)).subarray(0, 132);
    const kind = sniffKind(head);

    // Identity is (batch, filename), never content: the same exported instance
    // legitimately arrives in two batches from two centers, and a content-keyed id
    // made the second one silently disappear. Same-name repeats inside one batch are
    // still deduplicated by the unique index below.
    const fileId = `f-${createHash('sha1').update(`${batchId}|${filename}`).digest('hex').slice(0, 16)}`;
    try {
      await db.insert(uploadFiles).values({
        id: fileId, batchId, filename, storedPath, bytes: received, sha256: digest,
        kind, status: kind === 'non_dicom' ? 'quarantined' : 'stored',
        errorCode: kind === 'non_dicom' ? 'not_dicom' : null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return res.status(200).json({ ok: true, fileId, duplicate: true, note: 'same filename already staged in this batch' });
      }
      throw err;
    }

    await db.update(uploadBatches).set({ bytesReceived: sql`${uploadBatches.bytesReceived} + ${received}` })
      .where(eq(uploadBatches.id, batchId));

    res.json({ ok: true, fileId, bytes: received, kind, quarantined: kind === 'non_dicom' });
  });

  r.post('/batches/:batchId/seal', async (req: Ctx, res) => {
    const who = uploader(req);
    if (!who) return res.status(400).json({ ok: false, error: 'tenant_required' });
    const batchId = cleanText(req.params.batchId, 64);

    const [batch] = await db.select().from(uploadBatches).where(eq(uploadBatches.id, batchId)).limit(1);
    if (!batch) return res.status(404).json({ ok: false, error: 'batch_not_found' });
    if (who.channel === 'agent' && batch.siteId !== who.siteId) return res.status(403).json({ ok: false, error: 'forbidden' });

    const counts = await db.select({
      stored: sql<number>`count(*) filter (where ${uploadFiles.status} = 'stored')::int`,
      quarantined: sql<number>`count(*) filter (where ${uploadFiles.status} = 'quarantined')::int`,
    }).from(uploadFiles).where(eq(uploadFiles.batchId, batchId));
    const stored = counts[0]?.stored ?? 0;
    if (stored === 0) {
      return res.status(422).json({ ok: false, error: 'no_dicom_files_received', ...counts[0] });
    }

    await db.update(uploadBatches).set({ status: 'sealed', sealedAt: new Date() }).where(eq(uploadBatches.id, batchId));
    await appendAudit(db, {
      actorUserId: who.actorUserId, actorKind: who.channel === 'agent' ? 'service' : 'human',
      tenantId: batch.tenantId, action: 'upload.batch_sealed', entity: 'upload_batches', entityId: batchId,
      detail: { stored, quarantined: counts[0]?.quarantined ?? 0, filesExpected: batch.filesExpected },
    });
    res.json({ ok: true, batchId, stored, quarantined: counts[0]?.quarantined ?? 0 });
  });

  r.get('/batches', async (req: Ctx, res) => {
    const who = uploader(req);
    if (!who) return res.status(400).json({ ok: false, error: 'tenant_required' });
    const rows = await db.select().from(uploadBatches)
      .where(and(
        eq(uploadBatches.tenantId, who.tenantId),
        ['open', 'sealed', 'processing', 'ingested', 'partial', 'rejected']
          .includes(cleanText(req.query.status ?? '', 16))
          ? eq(uploadBatches.status, cleanText(req.query.status as string, 16) as 'open' | 'sealed' | 'processing' | 'ingested' | 'partial' | 'rejected')
          : sql`true`,
      ))
      .orderBy(desc(uploadBatches.createdAt)).limit(100);
    res.json({ ok: true, batches: rows });
  });

  r.get('/batches/:batchId', async (req: Ctx, res) => {
    const who = uploader(req);
    if (!who) return res.status(400).json({ ok: false, error: 'tenant_required' });
    const batchId = cleanText(req.params.batchId, 64);
    const [batch] = await db.select().from(uploadBatches).where(eq(uploadBatches.id, batchId)).limit(1);
    if (!batch || (batch.tenantId !== who.tenantId && who.channel === 'agent')) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const files = await db.select().from(uploadFiles).where(eq(uploadFiles.batchId, batchId)).orderBy(uploadFiles.filename).limit(5000);
    res.json({ ok: true, batch, files });
  });

  // This router is mounted ahead of the session-scoped ones, so a path that matches
  // none of its routes has to be answered here. Falling through would hand the
  // request to a requireAuth guard and report a wrong URL as 401 to an agent token
  // that authenticated fine.
  r.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return r;
}
