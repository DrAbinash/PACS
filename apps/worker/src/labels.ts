// Orthanc 1.13.0 restricts label names to `[A-Za-z0-9_-]`, max 64 chars, and answers
// 400 "Parameter out of range" for anything else — so the obvious `telrad:batch:<id>`
// form cannot be used. Dashes also mean a label never needs url-encoding.
const PREFIX = 'telrad-batch-';

export function batchLabel(batchId: string): string {
  return `${PREFIX}${batchId}`;
}

// Every batch label on an instance, not just the first. One instance can legitimately
// carry two: a center re-uploading a study, or a center forwarding pixels that a
// second center also uploaded. Which tenant that study belongs to is then a fact to
// be checked against the batches, not a list order to be trusted.
export function batchIdsFromLabels(labels: string[]): string[] {
  const ids = new Set<string>();
  for (const l of labels) {
    if (l.startsWith(PREFIX) && l.length > PREFIX.length) ids.add(l.slice(PREFIX.length));
  }
  return [...ids];
}

export type BatchClaim = { tenantId: number | null; siteId: number | null };

export type Attribution =
  | { kind: 'tenant'; tenantId: number; siteId: number | null }
  /** Two batches that still exist disagree about the tenant. */
  | { kind: 'conflict' }
  /** No label, or only labels whose batch is gone — which is not evidence. */
  | { kind: 'none' };

export function attributeByBatch(rows: BatchClaim[]): Attribution {
  const tenants = new Set(rows.map((r) => r.tenantId).filter((t): t is number => t !== null));
  if (tenants.size > 1) return { kind: 'conflict' };
  if (tenants.size === 0) return { kind: 'none' };
  const sites = [...new Set(rows.map((r) => r.siteId))];
  // Batches from one center name one site; batches from two sites of the same tenant
  // leave the site unknown but the tenant certain.
  return { kind: 'tenant', tenantId: [...tenants][0]!, siteId: sites.length === 1 ? sites[0] ?? null : null };
}
