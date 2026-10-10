import { describe, expect, it } from 'vitest';
import {
  backoffSeconds, folderSignature, groupByFolder, hintsFromFolder, isSettled, parseTemplate,
  planBatches, plausibleAccession, plausibleDate, plausibleModality, redactFolder,
  type DiscoveredFile,
} from '../src/collect.js';

const file = (over: Partial<DiscoveredFile> = {}): DiscoveredFile => ({
  path: `/watch/ACC-4477-20261010/img-0001.dcm`,
  name: 'img-0001.dcm',
  folder: 'ACC-4477-20261010',
  bytes: 512,
  mtimeMs: 1_000,
  ...over,
});

describe('the settle rule', () => {
  const now = 1_000_000;

  it('refuses a file that was written a moment ago', () => {
    expect(isSettled(file({ mtimeMs: now - 1000 }), now, 60)).toBe(false);
  });

  it('takes a file whose last write was past the window', () => {
    expect(isSettled(file({ mtimeMs: now - 61_000 }), now, 60)).toBe(true);
    expect(isSettled(file({ mtimeMs: now - 60_000 }), now, 60)).toBe(true);
  });

  it('is a floor and not a promise, so a zero window still means something', () => {
    expect(isSettled(file({ mtimeMs: now }), now, 0)).toBe(true);
  });
});

describe('folder grouping', () => {
  it('keeps one folder as one study', () => {
    const groups = groupByFolder([
      file({ name: 'a.dcm' }), file({ name: 'b.dcm' }),
      file({ name: 'c.dcm', folder: 'other', path: '/watch/other/c.dcm' }),
    ]);
    expect([...groups.keys()]).toEqual(['ACC-4477-20261010', 'other']);
    expect(groups.get('ACC-4477-20261010')).toHaveLength(2);
  });

  it('lists folders in a stable order so a reboot does not renumber a study', () => {
    const a = file({ folder: 'A', name: 'x.dcm', path: '/watch/A/x.dcm' });
    const b = file({ folder: 'B', name: 'x.dcm', path: '/watch/B/x.dcm' });
    expect([...groupByFolder([b, a]).keys()]).toEqual(['A', 'B']);
  });

  it('treats loose files at the root as their own folder', () => {
    expect([...groupByFolder([file({ folder: '', path: '/watch/x.dcm' })]).keys()]).toEqual(['']);
  });
});

describe('the two-scan stability test', () => {
  it('is not stable the first time a folder is seen', () => {
    // A brand new folder on a reboot must not be sealed by whichever scan happens to land on it
    // first; the modality may still be writing.
    expect(folderSignature([file()])).not.toBeNull();
    expect(folderSignature([file()])).toBe(folderSignature([file()]));
  });

  it('changes when a file is added, so the folder waits for another pass', () => {
    const one = folderSignature([file({ name: 'a.dcm' })]);
    const two = folderSignature([file({ name: 'a.dcm' }), file({ name: 'b.dcm' })]);
    expect(one).not.toBe(two);
  });

  it('changes when the same name is rewritten with different bytes', () => {
    const before = folderSignature([file({ name: 'a.dcm', bytes: 100 })]);
    const after = folderSignature([file({ name: 'a.dcm', bytes: 101 })]);
    expect(before).not.toBe(after);
  });

  it('ignores the order the directory was listed in', () => {
    const a = file({ name: 'a.dcm' });
    const b = file({ name: 'b.dcm' });
    expect(folderSignature([a, b])).toBe(folderSignature([b, a]));
  });
});

describe('what goes in the log', () => {
  it('is a digest of the folder, because the folder is often the patient', () => {
    const redacted = redactFolder('KAVITA RAO CT HEAD 20261010');
    expect(redacted).not.toContain('KAVITA');
    expect(redacted).toMatch(/^[0-9a-f]{10}$/);
    expect(redacted).toBe(redactFolder('KAVITA RAO CT HEAD 20261010'));
    expect(redacted).not.toBe(redactFolder('RAVI KUMAR CT HEAD 20261010'));
  });
});

describe('the hint template', () => {
  it('captures only the three tokens that exist', () => {
    expect(parseTemplate('{accession}-{date}')).toEqual([
      { kind: 'accession' }, { kind: 'text', value: '-' }, { kind: 'date' },
    ]);
  });

  it('refuses a patient token instead of silently capturing a name', () => {
    // The tempting fourth token is the one that puts a patient's name into a column another
    // user of the tenant can read. It is not available, and asking for it is an error.
    expect(() => parseTemplate('{patient}')).toThrow(/unknown token/);
    expect(() => parseTemplate('{mrn}')).toThrow(/unknown token/);
    expect(() => parseTemplate('{name}')).toThrow(/unknown token/);
  });

  it('refuses an unterminated token rather than sending the brace', () => {
    expect(() => parseTemplate('{accession')).toThrow(/unclosed/);
  });

  it('applies the operator’s convention to a folder name', () => {
    expect(hintsFromFolder('ACC-4477-20261010', parseTemplate('{accession}-{date}')))
      .toEqual({ accessionHint: 'ACC-4477', studyDateHint: '20261010', modalityHint: null });
  });

  it('uppercases an accession a writer left in lower case', () => {
    expect(hintsFromFolder('acc-4477', parseTemplate('{accession}')).accessionHint).toBe('ACC-4477');
  });

  it('drops the whole set of hints when the name does not fit the template', () => {
    expect(hintsFromFolder('no separator here', parseTemplate('{accession}-{date}')))
      .toEqual({ accessionHint: null, studyDateHint: null, modalityHint: null });
  });

  it('reads the leaf folder, not a parent that happens to hold a date', () => {
    expect(hintsFromFolder('2026-10/pat-99', parseTemplate('{date}')).studyDateHint).toBeNull();
  });

  it('matches a literal case-insensitively, which is what a Windows export name needs', () => {
    expect(hintsFromFolder('ACC-4477 STUDY', parseTemplate('{accession} STUDY')).accessionHint)
      .toBe('ACC-4477');
  });
});

describe('what counts as an accession', () => {
  it('accepts the shapes real worklists use', () => {
    expect(plausibleAccession('ACC-4477')).toBe('ACC-4477');
    expect(plausibleAccession('A1234567')).toBe('A1234567');
    expect(plausibleAccession('RCT.2026.44')).toBe('RCT.2026.44');
  });

  it('rejects a person’s name, which is what a folder usually is', () => {
    expect(plausibleAccession('KAVITA RAO')).toBeNull();
    expect(plausibleAccession('KAVITA_RAO')).toBeNull();
    expect(plausibleAccession('RAO')).toBeNull();
  });

  it('rejects anything with no digit in it', () => {
    expect(plausibleAccession('STUDYONLY')).toBeNull();
  });

  it('rejects a value too long to be stored', () => {
    expect(plausibleAccession(`A${'9'.repeat(70)}`)).toBeNull();
  });
});

describe('the other two hints', () => {
  it('takes only a real YYYYMMDD', () => {
    expect(plausibleDate('20261010')).toBe('20261010');
    expect(plausibleDate('2026-10-10')).toBe('20261010');
    expect(plausibleDate('20261345')).toBeNull();
    expect(plausibleDate('19621010')).toBeNull();
    expect(plausibleDate('2026101')).toBeNull();
  });

  it('takes only a two-to-four letter modality', () => {
    expect(plausibleModality('ct')).toBe('CT');
    expect(plausibleModality('MR')).toBe('MR');
    expect(plausibleModality('4477')).toBeNull();
    expect(plausibleModality('CHEST')).toBeNull();
  });
});

describe('batch planning against the server’s own limits', () => {
  const many = (n: number, bytes = 100): DiscoveredFile[] =>
    Array.from({ length: n }, (_, i) => file({ name: `i-${String(i).padStart(4, '0')}.dcm`, bytes }));

  it('keeps a normal study in one batch and declares its real size', () => {
    const plans = planBatches(many(3), { maxFiles: 4000, maxBytes: 1_000_000 });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ part: 1, parts: 1, files: many(3), bytes: 300 });
  });

  it('splits on the file cap and numbers the parts', () => {
    const plans = planBatches(many(5), { maxFiles: 2, maxBytes: 1_000_000 });
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => `${p.part}/${p.parts}`)).toEqual(['1/3', '2/3', '3/3']);
    expect(plans[1]!.files).toHaveLength(2);
  });

  it('splits on the byte cap too, which is the one an MRI hits', () => {
    const plans = planBatches(many(4, 300), { maxFiles: 4000, maxBytes: 700 });
    expect(plans.map((p) => p.bytes)).toEqual([600, 600]);
  });

  it('never puts two folders in one batch', () => {
    const plans = planBatches([
      ...many(2),
      ...many(2).map((f) => ({ ...f, folder: 'other', path: '/watch/other/x' })),
    ], { maxFiles: 4000, maxBytes: 1_000_000 });
    expect(plans).toHaveLength(2);
    expect(new Set(plans.map((p) => p.folder))).toEqual(new Set(['ACC-4477-20261010', 'other']));
  });

  it('sends nothing for an empty listing', () => {
    expect(planBatches([], { maxFiles: 2, maxBytes: 2 })).toEqual([]);
  });

  it('orders a batch by filename, so a re-scan of one study builds the same batch', () => {
    const shuffled = [file({ name: 'z.dcm' }), file({ name: 'a.dcm' })];
    expect(planBatches(shuffled, { maxFiles: 10, maxBytes: 10_000 })[0]!.files.map((f) => f.name))
      .toEqual(['a.dcm', 'z.dcm']);
  });
});

describe('the retry ladder', () => {
  it('waits longer each time and stops growing', () => {
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBeGreaterThan(backoffSeconds(1));
    expect(backoffSeconds(9)).toBeLessThanOrEqual(900);
    expect(backoffSeconds(9)).toBe(backoffSeconds(99));
  });

  it('does not invent a wait for a folder that has never failed', () => {
    expect(backoffSeconds(0)).toBe(0);
  });
});
