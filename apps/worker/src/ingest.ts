import {
  classifyStudy, resolveStudyToOrder,
  type CandidateOrder, type DicomTags, type Priority,
} from '@telrad/shared';
import type { InstanceRead, OrthancReader } from './orthanc.js';

export type OrderCandidate = CandidateOrder & { patientId: number };

export type StudyDraft = {
  storageNodeId: string;
  nodePk: string;
  studyInstanceUid: string;
  tenantId: number | null;
  siteId: number | null;
  orderId: number | null;
  patientId: number | null;
  accessionNumber: string | null;
  studyDate: string | null;
  modalityCode: string;
  subSpecialtyCode: string | null;
  studyDescription: string | null;
  priority: Priority;
  linkState: 'linked' | 'orphan' | 'ambiguous' | 'unlinked_read_only';
  matchMethod: 'accession' | 'scored' | 'manual' | 'none';
  matchScore: number;
  receivedAt: Date;
  instanceBytes: number | null;
  classification: Record<string, unknown>;
  qualityFlags: string[];
};

export type Provenance = InstanceRead['provenance'];

export type StorePort = {
  cursor(): Promise<{ nodeId: string; since: number | null }>;
  saveCursor(cursor: number, seen: number): Promise<void>;
  failCursor(message: string): Promise<void>;
  resolveSite(prov: Provenance): Promise<{ tenantId: number; siteId: number | null } | null>;
  candidateOrders(tenantId: number, tags: DicomTags): Promise<OrderCandidate[]>;
  slaMinutesFor(subSpecialtyCode: string | null, priority: Priority): Promise<number | null>;
  /** Idempotent on (storageNodeId, studyInstanceUid). A resumed cursor must not
   * create a second study row, and must not reopen a clock. `receivedAt` is the
   * first time this study was ever seen, which on an update pass is older than the
   * draft that was just written. */
  write(draft: StudyDraft): Promise<{ id: number; created: boolean; receivedAt: Date }>;
  event(studyId: number, kind: 'received' | 'classified' | 'linked' | 'orphaned', detail: unknown): Promise<void>;
  /** False when a clock already exists, which is what makes this safe to ask for on
   * every poll. */
  openSlaClock(studyId: number, tenantId: number, priority: Priority, deadlineAt: Date): Promise<boolean>;
  /** Studies this node filed as still arriving. Orthanc flips a study to stable about
   * two minutes after the last instance and emits no change event for the flip, so
   * these will never be looked at again unless somebody asks. */
  stalledStudies(nodeId: string, limit: number): Promise<StalledStudy[]>;
  /** Drops the 'study_not_complete' flag and nothing else. False when the flag was
   * already gone, which is what keeps a concurrent re-check from doubling the clock. */
  clearStalledFlag(studyId: number): Promise<boolean>;
};

export type StalledStudy = {
  id: number;
  nodePk: string | null;
  tenantId: number | null;
  linkState: 'linked' | 'orphan' | 'ambiguous' | 'unlinked_read_only';
  priority: Priority;
  subSpecialtyCode: string | null;
  qualityFlags: string[];
  receivedAt: Date;
};

export type IngestResult = {
  seen: number; created: number; updated: number;
  orphans: number; ambiguous: number; unresolvedSite: number;
  incomplete: number; slaOpened: number;
};

export function emptyResult(): IngestResult {
  return {
    seen: 0, created: 0, updated: 0, orphans: 0, ambiguous: 0,
    unresolvedSite: 0, incomplete: 0, slaOpened: 0,
  };
}

export async function pollOnce(
  orthanc: OrthancReader,
  store: StorePort,
  opts: { nodeId: string; limit?: number; now?: () => Date },
): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date());
  const r = emptyResult();

  const { since } = await store.cursor();
  const { entries, cursor } = await orthanc.changes(since, opts.limit ?? 200);

  try {
    for (const entry of entries) {
      r.seen += 1;
      const read = await orthanc.read(entry.id, entry.seq);
      const tags = read.tags;
      const classification = classifyStudy(tags);
      const studyInstanceUid = read.studyInstanceUid
        || `node:${opts.nodeId}/pk:${read.nodeStudyPk}/i:${entry.id}`;

      // Orthanc marks a study IsStable while instances are still arriving. Assigning
      // a partial study is how a missing sequence turns into a wrong report, so an
      // unstable study is recorded and flagged but kept off the queue.
      const flags = classification.needsHumanReview ? [...classification.reasons] : [];
      if (!read.provenance.stable) {
        flags.push('study_not_complete');
        r.incomplete += 1;
      }

      const site = await store.resolveSite(read.provenance);

      if (!site) {
        const { id, created } = await store.write({
          storageNodeId: opts.nodeId, nodePk: read.nodeStudyPk, studyInstanceUid,
          tenantId: null, siteId: null, orderId: null, patientId: null,
          accessionNumber: tags.AccessionNumber ?? null,
          studyDate: tags.StudyDate ?? null,
          modalityCode: classification.modalityCode,
          subSpecialtyCode: classification.subSpecialtyCode,
          studyDescription: tags.StudyDescription ?? null,
          priority: 'routine',
          linkState: 'orphan', matchMethod: 'none', matchScore: 0,
          receivedAt: now(), instanceBytes: read.bytes,
          classification: { reasons: ['site_unresolved', ...classification.reasons], provenance: read.provenance },
          qualityFlags: ['site_unresolved', ...flags],
        });
        if (created) { r.created += 1; } else { r.updated += 1; }
        await store.event(id, 'orphaned', { reason: 'site_unresolved', provenance: read.provenance });
        r.unresolvedSite += 1;
        r.orphans += 1;
        continue;
      }

      const orders = await store.candidateOrders(site.tenantId, tags);
      const match = resolveStudyToOrder(
        {
          accessionNumber: tags.AccessionNumber,
          patientName: tags.PatientName,
          patientId: tags.PatientID,
          patientBirthDate: tags.PatientBirthDate,
          studyDate: tags.StudyDate,
          modalityCode: classification.modalityCode,
          siteId: site.siteId,
        },
        orders,
      );
      const matched = match.orderId !== null ? orders.find((o) => o.orderId === match.orderId) : undefined;

      const receivedAt = now();
      const draft: StudyDraft = {
        storageNodeId: opts.nodeId, nodePk: read.nodeStudyPk, studyInstanceUid,
        tenantId: site.tenantId, siteId: site.siteId,
        orderId: match.orderId, patientId: matched?.patientId ?? null,
        accessionNumber: tags.AccessionNumber ?? null,
        studyDate: tags.StudyDate ?? null,
        modalityCode: classification.modalityCode,
        subSpecialtyCode: classification.subSpecialtyCode,
        studyDescription: tags.StudyDescription ?? null,
        priority: classification.priority,
        linkState: match.state,
        matchMethod: match.method,
        matchScore: match.score,
        receivedAt,
        instanceBytes: read.bytes,
        classification: {
          ...classification,
          provenance: read.provenance,
          match: { state: match.state, method: match.method, score: match.score, reasons: match.reasons },
        },
        qualityFlags: flags,
      };

      const written = await store.write(draft);
      const id = written.id;
      const created = written.created;
      if (created) { r.created += 1; } else { r.updated += 1; }

      if (match.state === 'orphan') {
        await store.event(id, 'orphaned', { reasons: match.reasons });
        r.orphans += 1;
      } else if (match.state === 'ambiguous') {
        await store.event(id, 'classified', { reasons: match.reasons });
        r.ambiguous += 1;
      } else {
        await store.event(id, 'linked', { method: match.method, score: match.score, orderId: match.orderId });
        // A clock opens the first time a study is both linked and complete, which is
        // usually *not* the pass that created the row: Orthanc keeps calling a study
        // unstable for about two minutes after its last instance lands, and the
        // poller runs every ten seconds. Measuring from the row's first-sight time
        // rather than this pass's clock keeps the deadline honest either way, and
        // the unique index on study_id means a later poll cannot open a second one.
        if (flags.length === 0) {
          const minutes = await store.slaMinutesFor(classification.subSpecialtyCode, classification.priority);
          if (minutes) {
            const opened = await store.openSlaClock(
              id, site.tenantId, classification.priority,
              new Date(written.receivedAt.getTime() + minutes * 60_000),
            );
            if (opened) r.slaOpened += 1;
          }
        }
      }
    }

    await store.saveCursor(cursor, r.seen);
    return r;
  } catch (err) {
    await store.failCursor(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export type SettleResult = { seen: number; completed: number; clocks: number };

// The second look a study gets when nothing new arrived to make the poller read it
// again. Without this, a center that sends a whole study in one batch is filed as
// incomplete, stays incomplete forever, and — since an incomplete study is not
// dispatchable — never reaches a radiologist. Measured, not theoretical: the first
// dispatch run produced three studies with two instances each and none of them ever
// left the stalled set.
export async function recheckStalled(
  orthanc: OrthancReader,
  store: StorePort,
  opts: { nodeId: string; limit?: number },
): Promise<SettleResult> {
  const r: SettleResult = { seen: 0, completed: 0, clocks: 0 };

  for (const row of await store.stalledStudies(opts.nodeId, opts.limit ?? 20)) {
    if (!row.nodePk) continue;
    r.seen += 1;
    if (!(await orthanc.studyStable(row.nodePk))) continue;

    if (!(await store.clearStalledFlag(row.id))) continue;
    r.completed += 1;

    // The clock opens from first sight, exactly as it does on the ingest path, so a
    // study that took two minutes to settle is not given those two minutes back.
    if (row.tenantId !== null && row.linkState === 'linked') {
      const remaining = row.qualityFlags.filter((f) => f !== 'study_not_complete');
      if (remaining.length === 0) {
        const minutes = await store.slaMinutesFor(row.subSpecialtyCode, row.priority);
        if (minutes) {
          const opened = await store.openSlaClock(
            row.id, row.tenantId, row.priority,
            new Date(row.receivedAt.getTime() + minutes * 60_000),
          );
          if (opened) r.clocks += 1;
        }
      }
    }
  }

  return r;
}
