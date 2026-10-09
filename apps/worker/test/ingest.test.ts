import { describe, expect, it } from 'vitest';
import { pollOnce, recheckStalled, type StalledStudy, type StorePort, type StudyDraft } from '../src/ingest.js';
import type { InstanceRead, OrthancReader } from '../src/orthanc.js';
import type { DicomTags } from '@telrad/shared';

type Captured = {
  drafts: Map<string, StudyDraft>;
  firstSeen: Map<string, Date>;
  events: { studyId: number; kind: string; detail: unknown }[];
  clocks: { studyId: number; deadline: Date }[];
  cursor: number | null;
  stableAsked: string[];
  cleared: number[];
};

function instance(tags: DicomTags, over?: Partial<InstanceRead>): InstanceRead {
  return {
    instanceId: 'inst-1',
    nodeStudyPk: 'study-pk-1',
    studyInstanceUid: tags.StudyInstanceUID ?? null,
    tags,
    provenance: { remoteAet: 'MR_SCANNER_1', remoteIp: '10.0.0.5', stable: true, labels: [] },
    bytes: 4096,
    seq: 1,
    ...over,
  };
}

function fakes(opts: {
  instances: InstanceRead[];
  site?: { tenantId: number; siteId: number | null } | null;
  orders?: StorePort['candidateOrders'];
  stalled?: StalledStudy[];
  stable?: boolean;
}) {
  const cap: Captured = {
    drafts: new Map(), firstSeen: new Map(), events: [], clocks: [], cursor: null,
    stableAsked: [], cleared: [],
  };
  let nextId = 100;

  const orthanc: OrthancReader = {
    async changes() {
      return {
        entries: opts.instances.map((i, n) => ({ id: `i${n}`, seq: n + 1 })),
        cursor: opts.instances.length,
      };
    },
    async read(id) {
      const idx = Number(id.slice(1));
      return opts.instances[idx]!;
    },
    async studyStable(nodeStudyPk) {
      cap.stableAsked.push(nodeStudyPk);
      return opts.stable ?? true;
    },
  };

  const store: StorePort = {
    async cursor() { return { nodeId: 'node-test', since: null }; },
    async saveCursor(cursor) { cap.cursor = cursor; },
    async failCursor() { /* asserted by the cursor contract, not here */ },
    async resolveSite() { return opts.site === undefined ? { tenantId: 1, siteId: 1 } : opts.site; },
    candidateOrders: opts.orders ?? (async () => []),
    async slaMinutesFor() { return 240; },
    async write(draft) {
      const existing = cap.drafts.has(draft.studyInstanceUid);
      cap.drafts.set(draft.studyInstanceUid, draft);
      // Mirrors the row: received_at is not in the update set, so an update pass
      // answers with the time the study was first seen.
      const firstSeen = cap.firstSeen.get(draft.studyInstanceUid) ?? draft.receivedAt;
      cap.firstSeen.set(draft.studyInstanceUid, firstSeen);
      if (existing) return { id: 100, created: false, receivedAt: firstSeen };
      const id = nextId++;
      return { id, created: true, receivedAt: firstSeen };
    },
    async event(studyId, kind, detail) { cap.events.push({ studyId, kind, detail }); },
    async openSlaClock(studyId, _t, _p, deadline) {
      // The unique index on study_id: a second open for the same study changes nothing.
      if (cap.clocks.some((c) => c.studyId === studyId)) return false;
      cap.clocks.push({ studyId, deadline });
      return true;
    },
    async stalledStudies() { return opts.stalled ?? []; },
    async clearStalledFlag(studyId) {
      // Mirrors the guarded update: the flag is only there to clear once.
      if (cap.cleared.includes(studyId)) return false;
      cap.cleared.push(studyId);
      return true;
    },
  };

  return { orthanc, store, cap };
}

const brainTags: DicomTags = {
  Modality: 'MR',
  StudyInstanceUID: '1.2.3.4',
  StudyDescription: 'MR BRAIN',
  PatientName: 'Ramesh Kumar',
  PatientID: 'P-00010',
  PatientBirthDate: '19780412',
  StudyDate: '20261008',
  AccessionNumber: 'ACC-20261008-MR-001',
};

const matchingOrder = {
  orderId: 7,
  patientId: 42,
  accessionNumber: 'ACC-20261008-MR-001',
  patientName: 'RAMESH KUMAR',
  patientMrn: 'P-00010',
  dob: '19780412',
  studyDate: '20261008',
  modalityCode: 'MR',
  siteId: 1,
};

describe('pollOnce', () => {
  it('links by accession, records the link and opens one clock', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [instance(brainTags)],
      orders: async () => [matchingOrder],
    });
    const r = await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect(r).toMatchObject({ seen: 1, created: 1, orphans: 0, ambiguous: 0, incomplete: 0, slaOpened: 1 });
    const draft = cap.drafts.get('1.2.3.4')!;
    expect(draft.linkState).toBe('linked');
    expect(draft.orderId).toBe(7);
    expect(draft.patientId).toBe(42);
    expect(draft.subSpecialtyCode).toBe('mr-head');
    expect(draft.nodePk).toBe('study-pk-1');
    expect(draft.instanceBytes).toBe(4096);
    expect(cap.clocks).toHaveLength(1);
    expect(cap.events.map((e) => e.kind)).toEqual(['linked']);
    expect(cap.cursor).toBe(1);
  });

  it('keeps a study from an unknown sending AE title out of every real tenant', async () => {
    const { orthanc, store, cap } = fakes({ instances: [instance(brainTags)], site: null });
    const r = await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect(r.unresolvedSite).toBe(1);
    const draft = cap.drafts.get('1.2.3.4')!;
    expect(draft.tenantId).toBeNull();
    expect(draft.qualityFlags).toContain('site_unresolved');
    expect(cap.clocks).toHaveLength(0);
    // The provenance is kept so the operator can add the missing site from real data.
    expect((draft.classification as { provenance?: { remoteAet?: string } }).provenance?.remoteAet)
      .toBe('MR_SCANNER_1');
  });

  it('does not open a clock when the sub-category could not be resolved', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [instance({ ...brainTags, StudyDescription: 'SOMETHING ODD' })],
      orders: async () => [matchingOrder],
    });
    const r = await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect(r.slaOpened).toBe(0);
    expect(cap.clocks).toHaveLength(0);
    expect(cap.drafts.get('1.2.3.4')!.qualityFlags).toContain('region_unresolved');
  });

  it('records an in-transit study but keeps it off the queue', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [instance(brainTags, { provenance: { remoteAet: 'X', remoteIp: 'Y', stable: false, labels: [] } })],
      orders: async () => [matchingOrder],
    });
    const r = await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect(r.incomplete).toBe(1);
    expect(r.slaOpened).toBe(0);
    expect(cap.clocks).toHaveLength(0);
    expect(cap.drafts.get('1.2.3.4')!.qualityFlags).toContain('study_not_complete');
  });

  // The 10-second poller almost always meets a study before Orthanc finishes
  // declaring it stable, so "only open a clock on the creating pass" would leave
  // the majority of linked studies with no deadline at all.
  it('opens the clock on the poll that finds the study complete, measured from first sight', async () => {
    const arriving = instance(brainTags, {
      provenance: { remoteAet: 'CT_SCANNER_1', remoteIp: '10.0.0.9', stable: false, labels: ['telrad-batch-b-1'] },
    });
    const { orthanc, store, cap } = fakes({
      instances: [arriving],
      orders: async () => [matchingOrder],
    });

    const seen = [new Date('2026-10-08T10:00:00Z'), new Date('2026-10-08T10:02:00Z')];
    let calls = 0;
    const now = () => seen[Math.min(calls++, seen.length - 1)]!;

    const first = await pollOnce(orthanc, store, { nodeId: 'node-test', now });
    expect(first).toMatchObject({ created: 1, incomplete: 1, slaOpened: 0 });

    arriving.provenance.stable = true;
    const second = await pollOnce(orthanc, store, { nodeId: 'node-test', now });
    expect(second).toMatchObject({ created: 0, updated: 1, incomplete: 0, slaOpened: 1 });
    expect(cap.clocks).toHaveLength(1);
    expect(cap.clocks[0]!.deadline.getTime()).toBe(seen[0]!.getTime() + 240 * 60_000);

    const third = await pollOnce(orthanc, store, { nodeId: 'node-test', now });
    expect(third.slaOpened).toBe(0);
    expect(cap.clocks).toHaveLength(1);
  });

  it('orphans a study whose name contradicts the only candidate order', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [instance({
        ...brainTags, AccessionNumber: 'MISSING-ON-PURPOSE', PatientName: 'Sita Devi',
      })],
      orders: async () => [matchingOrder],
    });
    const r = await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect(r.orphans).toBe(1);
    const draft = cap.drafts.get('1.2.3.4')!;
    expect(draft.linkState).toBe('orphan');
    expect(draft.orderId).toBeNull();
    expect(cap.clocks).toHaveLength(0);
  });

  it('files a study with no uid under a node-scoped key rather than losing it', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [instance({ ...brainTags, StudyInstanceUID: undefined })],
    });
    await pollOnce(orthanc, store, { nodeId: 'node-test' });

    expect([...cap.drafts.keys()]).toEqual(['node:node-test/pk:study-pk-1/i:i0']);
  });
});

const stalled = (over: Partial<StalledStudy> = {}): StalledStudy => ({
  id: 500,
  nodePk: 'study-pk-1',
  tenantId: 1,
  linkState: 'linked',
  priority: 'urgent',
  subSpecialtyCode: 'ct-head',
  qualityFlags: ['study_not_complete'],
  receivedAt: new Date('2026-10-08T10:00:00Z'),
  ...over,
});

// This is the pass that keeps the dispatcher fed. A center that sends a whole study in
// one batch produces no further change events, so without a re-check the study stays
// flagged incomplete, and an incomplete study is by design not dispatchable — the queue
// would silently stop moving while every other signal looked healthy.
describe('recheckStalled', () => {
  it('clears the flag and opens the clock from first sight once the node calls it stable', async () => {
    const { orthanc, store, cap } = fakes({ instances: [], stalled: [stalled()] });
    const r = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(r).toEqual({ seen: 1, completed: 1, clocks: 1 });
    expect(cap.stableAsked).toEqual(['study-pk-1']);
    expect(cap.cleared).toEqual([500]);
    expect(cap.clocks[0]!.deadline.getTime()).toBe(new Date('2026-10-08T14:00:00Z').getTime());
  });

  it('leaves a study alone while the node still calls it in transit', async () => {
    const { orthanc, store, cap } = fakes({ instances: [], stalled: [stalled()], stable: false });
    const r = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(r).toEqual({ seen: 1, completed: 0, clocks: 0 });
    expect(cap.cleared).toEqual([]);
  });

  it('does not clock a study that carries another flag as well', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [],
      stalled: [stalled({ qualityFlags: ['study_not_complete', 'motion_artefact'] })],
    });
    const r = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(r).toMatchObject({ completed: 1, clocks: 0 });
    expect(cap.cleared).toEqual([500]);
  });

  it('clears an orphan that settled but keeps it out of the clock', async () => {
    const { orthanc, store, cap } = fakes({
      instances: [],
      stalled: [stalled({ linkState: 'orphan', tenantId: null })],
    });
    const r = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(r).toMatchObject({ completed: 1, clocks: 0 });
    expect(cap.cleared).toEqual([500]);
  });

  it('is idempotent when two ticks see the same settled study', async () => {
    const { orthanc, store, cap } = fakes({ instances: [], stalled: [stalled()] });
    await recheckStalled(orthanc, store, { nodeId: 'node-test' });
    const second = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(second).toEqual({ seen: 1, completed: 0, clocks: 0 });
    expect(cap.clocks).toHaveLength(1);
  });

  it('skips a row the node never gave a study key', async () => {
    const { orthanc, store, cap } = fakes({ instances: [], stalled: [stalled({ nodePk: null })] });
    const r = await recheckStalled(orthanc, store, { nodeId: 'node-test' });

    expect(r).toEqual({ seen: 0, completed: 0, clocks: 0 });
    expect(cap.stableAsked).toEqual([]);
  });
});
