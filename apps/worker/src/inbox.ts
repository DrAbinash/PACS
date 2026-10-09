import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { OrthancWriter } from './orthanc.js';
import { batchLabel } from './labels.js';
import { LIMITS } from '@telrad/shared';

export type InboxFile = { id: string; filename: string; storedPath: string; kind: 'dcm' | 'zip' | 'non_dicom'; status: string };
export type InboxStore = {
  claimBatch(nodeId: string): Promise<{ batchId: string; tenantId: number | null; files: InboxFile[] } | null>;
  markFile(id: string, status: 'pushed' | 'rejected', orthancInstanceId: string | null, errorCode: string | null): Promise<void>;
  finishBatch(batchId: string, status: 'ingested' | 'partial' | 'rejected', error: string | null): Promise<void>;
};

export type DrainResult = {
  batchId: string; pushed: number; rejected: number;
  /** Archived in the image node but without a batch label, so the study will land
   * in the orphan queue as site_unresolved instead of being attributed to a site. */
  unlabeled: number;
  error: string | null;
};

// The inbox is where an uploaded study becomes an archived one. It lives in the
// worker rather than the api so that a slow or refusing image node cannot block a
// receptionist's HTTP request, and so a retry is a new poll instead of a re-upload.
export async function drainOnce(
  orthanc: OrthancWriter,
  store: InboxStore,
  opts: { nodeId: string; inboxRoot: string; removeAfterPush: boolean },
): Promise<DrainResult | null> {
  const batch = await store.claimBatch(opts.nodeId);
  if (!batch) return null;

  let pushed = 0;
  let rejected = 0;
  let unlabeled = 0;
  const errors: string[] = [];
  const label = batchLabel(batch.batchId);

  const recordPush = async (file: InboxFile, instanceId: string, labelError: string | null) => {
    if (labelError) {
      unlabeled += 1;
      errors.push(`${file.filename}: ${labelError}`.slice(0, 200));
    }
    // An instance that is in the archive stays recorded as pushed even when its
    // label was refused — calling that a rejection would tell the center their
    // study was lost when it is really sitting in Orthanc awaiting attribution.
    await store.markFile(file.id, 'pushed', instanceId, labelError ? 'label_failed' : null);
    pushed += 1;
  };

  for (const file of batch.files) {
    if (file.status === 'pushed') continue;
    if (file.kind === 'non_dicom') { rejected += 1; continue; }

    // resolve() on both sides, because an operator writes TR_INBOX_ROOT with forward
    // slashes and Node on Windows hands back backslashes; a plain startsWith there
    // rejects every real file. Comparison is against the root plus a separator, so a
    // sibling directory named "inbox-old" cannot satisfy the check.
    const rootAbs = path.resolve(opts.inboxRoot);
    const abs = path.resolve(rootAbs, file.storedPath);
    if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) {
      rejected += 1;
      await store.markFile(file.id, 'rejected', null, 'unsafe_path');
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      rejected += 1;
      errors.push(`${file.filename}: missing from inbox`);
      await store.markFile(file.id, 'rejected', null, 'file_missing');
      continue;
    }

    try {
      if (file.kind === 'zip') {
        // Entry count is bounded before decompression, because the batch's declared
        // size says nothing about what a 40 MB archive can expand into.
        const entries = unzipSync(new Uint8Array(buffer), {
          filter: (f) => !f.name.endsWith('/') && f.name.length <= 255,
        });
        const names = Object.keys(entries);
        if (names.length > LIMITS.zipEntriesMax) throw new Error('zip_entry_limit');
        let total = 0;
        for (const n of names) {
          total += entries[n]!.length;
          if (total > LIMITS.zipUncompressedMax) throw new Error('zip_expansion_limit');
        }
        for (const name of names) {
          const bytes = entries[name]!;
          if (!looksLikeDicomHead(bytes)) {
            rejected += 1;
            await store.markFile(file.id, 'rejected', null, 'entry_not_dicom');
            continue;
          }
          const pushedMember = await orthanc.pushInstance(Buffer.from(bytes), [label]);
          await recordPush(file, pushedMember.instanceId, pushedMember.labelError);
        }
      } else {
        const result = await orthanc.pushInstance(buffer, [label]);
        await recordPush(file, result.instanceId, result.labelError);
      }

      if (opts.removeAfterPush) {
        try { rmSync(abs, { force: true }); } catch { /* the archive is the copy that matters */ }
      }
    } catch (err) {
      rejected += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${file.filename}: ${message.slice(0, 200)}`);
      await store.markFile(file.id, 'rejected', null, message.slice(0, 60));
    }
  }

  // Only a file that never reached the archive counts against the batch status: a
  // refused label is reported in last_error, because the study is present and will
  // show up in the orphan queue rather than being absent.
  const status = rejected > 0 && pushed === 0 ? 'rejected' : rejected > 0 ? 'partial' : 'ingested';
  await store.finishBatch(batch.batchId, status, errors.length ? errors.join('; ').slice(0, 500) : null);
  return { batchId: batch.batchId, pushed, rejected, unlabeled, error: errors.length ? errors.join('; ') : null };
}

// "DICM" at byte 128 of a Part-10 file. A zip member with no preamble may still be
// a valid Part-2 dataset, but Orthanc rejects those with a clear error, so the
// pre-check exists to keep junk out of the archive rather than to be authoritative.
function looksLikeDicomHead(bytes: Uint8Array): boolean {
  if (bytes.length < 132) return false;
  return bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}
