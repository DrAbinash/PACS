import { sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { appendAudit } from '@telrad/db';
import type { OrthancWriter } from './orthanc.js';

// Retention is the contract with each center: pixels for N days, records forever.
// The sweep deletes images and only images — the report, the billable events, the
// invoice and the audit chain outlive the study, because a center that paid for a
// read owns that read regardless of what happened to the underlying files.

// Eligibility is decided in one place. NULL tenant (orphans) is excluded by the
// join — an orphan's pixels belong to the orphan workflow, not to a policy that
// does not exist yet — and so are already-purged rows, pinned studies, and
// studies whose pixels never arrived (node_pk IS NULL: nothing to delete, and
// marking them purged would claim a deletion that never happened).
export type PurgeCandidate = {
  studyId: number;
  tenantId: number;
  storageNodeId: string;
  nodePk: string;
  retentionDays: number;
  receivedAt: Date;
};

export type RetentionPort = {
  candidates(now: Date, limit: number): Promise<PurgeCandidate[]>;
  removeStudy(nodePk: string): Promise<boolean>;
  markPurged(studyId: number, now: Date): Promise<boolean>;
  audit(input: { tenantId: number; studyId: number; detail: Record<string, unknown> }): Promise<void>;
};

export type RetentionResult = {
  checked: number;
  purged: number;
  failed: number;
  batches: number;
};

export function createRetentionStore(
  db: Db,
  orthanc: Pick<OrthancWriter, 'removeStudy'>,
): RetentionPort {
  return {
    async candidates(now, limit) {
      const rows = await db.execute<{
        study_id: number;
        tenant_id: number;
        storage_node_id: string;
        node_pk: string;
        retention_days: number;
        received_at: string | Date;
      }>(sql`
        select s.id as study_id, s.tenant_id, s.storage_node_id, s.node_pk,
               t.retention_days, s.received_at
          from telrad.studies s
          join telrad.tenants t on t.id = s.tenant_id
         where t.retention_days is not null
           and s.node_pk is not null
           and s.purged_at is null
           and s.pinned_at is null
           and s.received_at < ${now.toISOString()}::timestamptz
                 - (t.retention_days || ' days')::interval
         order by s.received_at
         limit ${limit}`);
      return rows.map((r) => ({
        studyId: Number(r.study_id),
        tenantId: Number(r.tenant_id),
        storageNodeId: r.storage_node_id,
        nodePk: r.node_pk,
        retentionDays: Number(r.retention_days),
        receivedAt: new Date(r.received_at),
      }));
    },

    removeStudy(nodePk) {
      return orthanc.removeStudy(nodePk);
    },

    async markPurged(studyId, now) {
      // Conditional so a concurrent sweep (or a second worker) cannot double-mark:
      // the loser returns false and skips its audit row.
      const rows = await db.execute<{ id: number }>(sql`
        update telrad.studies
           set purged_at = ${now.toISOString()}::timestamptz,
               retention_tier = 'purged'
         where id = ${studyId}
           and purged_at is null
        returning id`);
      return rows.length > 0;
    },

    async audit(input) {
      await appendAudit(db, {
        actorUserId: null,
        actorKind: 'system',
        tenantId: input.tenantId,
        action: 'retention.study_purged',
        entity: 'studies',
        entityId: String(input.studyId),
        detail: input.detail,
      });
    },
  };
}

// Pixels first, row second. A delete that succeeds and a mark that dies to a crash
// leave the row eligible again: the next run re-selects it, re-deletes (404, the
// node says already gone), and marks. The reverse order would be the row claiming
// a purge while pixels still sit on the node.
const BATCH = 25;
const MAX_BATCHES = 16;

export async function retentionSweepOnce(
  port: RetentionPort,
  opts: { now?: () => Date } = {},
): Promise<RetentionResult> {
  const now = opts.now ?? (() => new Date());
  const r: RetentionResult = { checked: 0, purged: 0, failed: 0, batches: 0 };

  for (;;) {
    const due = await port.candidates(now(), BATCH);
    if (due.length === 0) break;
    r.batches += 1;

    for (const c of due) {
      r.checked += 1;
      try {
        await port.removeStudy(c.nodePk);
      } catch (err) {
        // One refused delete aborts the run: a node refusing is a node down or a
        // node gone, and the rest would refuse too. The counts say where it
        // stopped; the next run resumes from the same first candidate.
        r.failed += 1;
        if (err instanceof Error) (r as { error?: string }).error = err.message.slice(0, 200);
        return r;
      }

      if (await port.markPurged(c.studyId, now())) {
        r.purged += 1;
        await port.audit({
          tenantId: c.tenantId,
          studyId: c.studyId,
          detail: {
            storageNodeId: c.storageNodeId,
            nodePk: c.nodePk,
            retentionDays: c.retentionDays,
            receivedAt: c.receivedAt.toISOString(),
            ageDays: Math.floor((now().getTime() - c.receivedAt.getTime()) / 86_400_000),
          },
        });
      }
    }

    if (r.batches >= MAX_BATCHES) break;
  }
  return r;
}
