import { describe, expect, it } from 'vitest';
import { retentionSweepOnce, type PurgeCandidate, type RetentionPort } from '../src/retention.js';

const NOW = new Date('2026-10-13T08:00:00Z');

const candidate = (over: Partial<PurgeCandidate> = {}): PurgeCandidate => ({
  studyId: 1,
  tenantId: 1,
  storageNodeId: 'node-nas-01',
  nodePk: 'orthanc-uuid-1',
  retentionDays: 7,
  receivedAt: new Date('2026-10-01T08:00:00Z'),
  ...over,
});

type Deletion = { nodePk: string };
type PurgeMark = { studyId: number };
type AuditRow = { tenantId: number; studyId: number; detail: Record<string, unknown> };

// The port is faked rather than the database being started: what is under test is the
// sweep's discipline — delete before mark, a refused delete stops the run, a
// double-marked row skips its audit — and every one of those is a decision, not a query.
function fakePort(opts: {
  due?: PurgeCandidate[];
  refuseDeleteFrom?: number;
  alreadyPurged?: number[];
} = {}) {
  const deletions: Deletion[] = [];
  const marks: PurgeMark[] = [];
  const audits: AuditRow[] = [];
  // Rows another sweep marked concurrently: visible to candidates until the race is
  // lost at mark time, gone from the pool afterwards — exactly the real query's view.
  const raced = new Set<number>();

  const port: RetentionPort = {
    async candidates(_now, limit) {
      // Like the real query: a row already marked (by this or another sweep) is no
      // longer due, so batches can actually drain.
      return (opts.due ?? [])
        .filter((c) => !marks.some((m) => m.studyId === c.studyId) && !raced.has(c.studyId))
        .slice(0, limit);
    },
    async removeStudy(nodePk) {
      deletions.push({ nodePk });
      if (opts.refuseDeleteFrom !== undefined && deletions.length >= opts.refuseDeleteFrom) {
        throw new Error('orthanc DELETE /studies 503: node unavailable');
      }
      return true;
    },
    async markPurged(studyId) {
      if (opts.alreadyPurged?.includes(studyId)) {
        raced.add(studyId);
        return false;
      }
      marks.push({ studyId });
      return true;
    },
    async audit(input) {
      audits.push(input);
    },
  };

  return { port, deletions, marks, audits };
}

describe('retentionSweepOnce', () => {
  it('deletes the pixels before marking the row, then audits with no patient data', async () => {
    const { port, deletions, marks, audits } = fakePort({
      due: [candidate({ studyId: 7, nodePk: 'pk-7' })],
    });

    const r = await retentionSweepOnce(port, { now: () => NOW });

    expect(r).toMatchObject({ checked: 1, purged: 1, failed: 0, batches: 1 });
    // The delete is on the node before the row can claim anything happened.
    expect(deletions).toEqual([{ nodePk: 'pk-7' }]);
    expect(marks).toEqual([{ studyId: 7 }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: 1, studyId: 7 });
    // The audit describes storage, never a patient: identifiers here are opaque ids.
    expect(Object.keys(audits[0]!.detail).sort()).toEqual(
      ['ageDays', 'nodePk', 'receivedAt', 'retentionDays', 'storageNodeId'],
    );
    expect(JSON.stringify(audits[0]!.detail)).not.toMatch(/patient|name/i);
  });

  it('drains more than one batch until nothing is due', async () => {
    const due = Array.from({ length: 30 }, (_, i) => candidate({ studyId: i + 1, nodePk: `pk-${i + 1}` }));
    const { port, marks } = fakePort({ due });

    const r = await retentionSweepOnce(port, { now: () => NOW });

    expect(r.batches).toBe(2);
    expect(r.purged).toBe(30);
    expect(marks).toHaveLength(30);
  });

  it('stops at the first refused delete and leaves that row unmarked', async () => {
    const { port, marks, audits } = fakePort({
      due: [candidate({ studyId: 1 }), candidate({ studyId: 2, nodePk: 'pk-2' })],
      refuseDeleteFrom: 2,
    });

    const r = await retentionSweepOnce(port, { now: () => NOW });

    expect(r).toMatchObject({ checked: 2, purged: 1, failed: 1 });
    expect(marks).toEqual([{ studyId: 1 }]);
    expect(audits).toHaveLength(1);
  });

  it('skips the audit row when another sweep already marked the study', async () => {
    const { port, audits } = fakePort({
      due: [candidate({ studyId: 5 })],
      alreadyPurged: [5],
    });

    const r = await retentionSweepOnce(port, { now: () => NOW });

    expect(r).toMatchObject({ checked: 1, purged: 0, failed: 0 });
    expect(audits).toHaveLength(0);
  });

  it('reports an empty run as nothing', async () => {
    const { port, deletions, marks } = fakePort({ due: [] });

    const r = await retentionSweepOnce(port, { now: () => NOW });

    expect(r).toMatchObject({ checked: 0, purged: 0, failed: 0, batches: 0 });
    expect(deletions).toHaveLength(0);
    expect(marks).toHaveLength(0);
  });
});
