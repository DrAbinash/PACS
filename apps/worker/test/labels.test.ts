import { describe, expect, it } from 'vitest';
import { attributeByBatch, batchIdsFromLabels, batchLabel } from '../src/labels.js';

describe('batch labels', () => {
  it('round-trips a real batch id', () => {
    const id = 'b-mv0ryt1s-a1e92268';
    expect(batchIdsFromLabels([batchLabel(id)])).toEqual([id]);
  });

  // Orthanc answers 400 for any name outside [A-Za-z0-9_-] and over 64 chars, and a
  // batch id is the only thing that can vary here, so the whole label is checked.
  it('stays inside the character set and length Orthanc accepts', () => {
    const label = batchLabel('b-mv0ryt1s-a1e92268');
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(label)).toBe(true);
  });

  it('ignores labels this worker did not write and keeps the ones it did', () => {
    expect(batchIdsFromLabels(['other', 'telrad-batch-', 'study-xyz'])).toEqual([]);
    expect(batchIdsFromLabels([batchLabel('b-1'), batchLabel('b-2'), 'name_y'])).toEqual(['b-1', 'b-2']);
  });
});

describe('attributeByBatch', () => {
  it('names the tenant and the site a single batch claims', () => {
    expect(attributeByBatch([{ tenantId: 4, siteId: 9 }]))
      .toEqual({ kind: 'tenant', tenantId: 4, siteId: 9 });
  });

  // The whole point of refusing: label order is not evidence, and picking one would
  // file a center's pixels into another center's queue.
  it('refuses an instance two tenants both claim', () => {
    expect(attributeByBatch([{ tenantId: 4, siteId: 9 }, { tenantId: 5, siteId: null }]))
      .toEqual({ kind: 'conflict' });
  });

  it('keeps the tenant when one tenant uploaded from two sites', () => {
    expect(attributeByBatch([{ tenantId: 4, siteId: 9 }, { tenantId: 4, siteId: 10 }]))
      .toEqual({ kind: 'tenant', tenantId: 4, siteId: null });
  });

  it('treats labels whose batch is gone as no evidence at all', () => {
    expect(attributeByBatch([])).toEqual({ kind: 'none' });
    expect(attributeByBatch([{ tenantId: null, siteId: null }])).toEqual({ kind: 'none' });
  });
});
