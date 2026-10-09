import { desc } from 'drizzle-orm';
import { auditRowHash } from '@telrad/shared';
import type { Db } from './index.js';
import { auditLog } from './schema.js';

export type AuditInput = {
  actorUserId: number | null;
  actorKind: 'human' | 'service' | 'system';
  tenantId: number | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: unknown;
};

// One implementation of the hash chain, here, because both the api (a person did
// something) and the worker (the clock ran out) have to write into it. Two copies of
// `prevHash` arithmetic is how a chain ends up verifying in one process and breaking in
// the other — and the chain is the thing an investigator reads.
//
// Reads of patient data are audited, not only writes. The question a regulator or a
// patient asks is "who looked at this study", and an append-only write log does not
// answer it.
export async function appendAudit(db: Db, input: AuditInput): Promise<string> {
  const [last] = await db
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);

  const occurredAt = new Date();
  const rowHash = auditRowHash({
    prevHash: last?.rowHash ?? null,
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    tenantId: input.tenantId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    detail: input.detail ?? null,
    occurredAt,
  });

  await db.insert(auditLog).values({
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    tenantId: input.tenantId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    detail: input.detail ?? null,
    occurredAt,
    prevHash: last?.rowHash ?? null,
    rowHash,
  });

  return rowHash;
}
