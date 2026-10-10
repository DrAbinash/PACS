import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentHttpError } from '../src/client.js';
import { parseArgs, sweep, type Config, type SweepDeps } from '../src/main.js';
import { emptyState, loadState, saveState } from '../src/state.js';

const HOME = mkdtempSync(path.join(tmpdir(), 'telrad-agent-sweep-'));

type Seed = { name: string; folder: string; bytes: number; mtimeMs: number };

const cfg = (argv: string[] = []): Config =>
  parseArgs(['--watch', HOME, '--api', 'https://telrad.test', '--settle', '60', ...argv], {});

const file = (name: string, over: Partial<Seed> = {}): Seed =>
  ({ name, folder: 'ACC-4477', bytes: 100, mtimeMs: 1_000, ...over });

function fakes(files: Seed[], over: {
  put?: (name: string) => Promise<{ ok: true; fileId: string; bytes: number; kind: string; quarantined: boolean }>;
  sealCode?: string;
} = {}) {
  const log: string[] = [];
  const sent: { batchId: string; name: string; sha: string }[] = [];
  const attempts: { batchId: string; name: string }[] = [];
  const opened: { batchId: string; filesExpected: number; hints: Record<string, unknown> }[] = [];
  const sealed: string[] = [];
  const hashed: string[] = [];
  let clock = 1_000_000;
  let counter = 0;

  const client = {
    async openBatch(input: { filesExpected: number; bytesDeclared: number; [k: string]: unknown }) {
      counter += 1;
      const batchId = `b-${counter}`;
      opened.push({ batchId, filesExpected: input.filesExpected, hints: input });
      return { ok: true as const, batchId, putPath: '/p', sealPath: '/s' };
    },
    async putFile(batchId: string, filename: string, _path: string, sha256: string) {
      // `attempts` is every call, `sent` only the ones the server took. The resume tests need to
      // see a file offered a second time, which is not the same thing as it being sent twice.
      attempts.push({ batchId, name: filename });
      const reply = over.put
        ? await over.put(filename)
        : { ok: true as const, fileId: `f-${filename}`, bytes: 100, kind: 'dicom', quarantined: false };
      sent.push({ batchId, name: filename, sha: sha256 });
      return reply;
    },
    async sealBatch(batchId: string) {
      if (over.sealCode) throw new AgentHttpError(422, over.sealCode, {});
      sealed.push(batchId);
      return { ok: true as const, batchId, stored: 1, quarantined: 0 };
    },
    async getBatch(batchId: string) {
      return {
        ok: true as const,
        batch: { id: batchId, status: 'sealed', filesExpected: 1, bytesReceived: 100 },
        files: [{ filename: 'i.dcm', bytes: 100, sha256: 'x', status: 'stored', errorCode: null }],
      };
    },
  };

  const deps: SweepDeps = {
    // The listing and the hashes are injected: what is being measured is the sweep's decisions,
    // and a test that builds real DICOM files measures the filesystem instead.
    client,
    now: () => clock,
    log: (line) => log.push(line),
    list: () => files.map((f) => ({
      path: `${HOME}/${f.folder}/${f.name}`, name: f.name, folder: f.folder,
      bytes: f.bytes, mtimeMs: f.mtimeMs,
    })),
    sha256: async (p) => {
      const name = p.split('/').pop()!;
      hashed.push(name);
      return `sha-${name}`;
    },
  };

  const state = emptyState(HOME);
  return {
    deps, log, sent, attempts, opened, sealed, hashed, state,
    clock: () => clock,
    advance: (seconds: number) => { clock += seconds * 1000; },
    settle: () => { for (const f of files) f.mtimeMs = clock - 120_000; },
  };
}

type Fakes = ReturnType<typeof fakes>;

/**
 * One scan. A folder is only taken when a *second* scan agrees with it, so every test that wants
 * to watch a send has to start by making the listing look finished without acting on it.
 */
async function prime(f: Fakes, c: Config = cfg()): Promise<void> {
  f.settle();
  await sweep(f.state, c, f.deps);
  f.log.length = 0;
  f.hashed.length = 0;
}

const folderOf = (f: Fakes, folder = 'ACC-4477') => f.state.folders[folder]!;

describe('the two scans that have to agree', () => {
  it('takes nothing on the first sight of a folder', async () => {
    const f = fakes([file('i1.dcm'), file('i2.dcm')]);
    f.settle();
    const first = await sweep(f.state, cfg(), f.deps);
    expect(first).toMatchObject({ folders: 1, ready: 0, waiting: 1, batches: 0 });
    expect(f.opened).toHaveLength(0);
    expect(f.log.join(' ')).toMatch(/waiting for a second scan/);
  });

  it('takes it on the second', async () => {
    const f = fakes([file('i1.dcm'), file('i2.dcm')]);
    await prime(f);
    const second = await sweep(f.state, cfg(), f.deps);
    expect(second).toMatchObject({ ready: 1, batches: 1, files: 2 });
    expect(f.sealed).toEqual(['b-1']);
  });

  it('waits when any file is inside the settle window, even when two scans agree', async () => {
    const f = fakes([file('i1.dcm'), file('i2.dcm', { mtimeMs: 999_990 })]);
    await sweep(f.state, cfg(), f.deps);
    const second = await sweep(f.state, cfg(), f.deps);
    expect(second).toMatchObject({ ready: 0, waiting: 1 });
    expect(second.batches).toBe(0);
  });

  it('--once acts on one scan, which is what a cron entry needs', async () => {
    const f = fakes([file('i1.dcm')]);
    f.settle();
    const s = await sweep(f.state, cfg(['--once']), f.deps);
    expect(s).toMatchObject({ ready: 1, batches: 1, files: 1 });
  });
});

describe('one pass of a ready folder', () => {
  it('opens one batch, sends every file with its own digest, seals it and reads it back', async () => {
    const f = fakes([file('i2.dcm'), file('i1.dcm')]);
    await prime(f);
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s).toMatchObject({ batches: 1, files: 2, bytes: 200 });
    expect(f.opened[0]).toMatchObject({ filesExpected: 2 });
    // Ordered by name, not by whatever order the directory returned.
    expect(f.sent.map((x) => x.name)).toEqual(['i1.dcm', 'i2.dcm']);
    expect(f.sent.map((x) => x.sha)).toEqual(['sha-i1.dcm', 'sha-i2.dcm']);
    expect(f.sealed).toEqual(['b-1']);
    expect(folderOf(f).batches[0]).toMatchObject({ batchId: 'b-1', sealed: true, filesExpected: 2 });
    expect(folderOf(f).files['i1.dcm']).toMatchObject({ status: 'uploaded', batchId: 'b-1' });
  });

  it('reports the batch as the server sees it, not as it remembers sending it', async () => {
    const f = fakes([file('i1.dcm')]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(f.log.join(' ')).toMatch(/sealed — server holds stored=1/);
  });

  it('sends nothing on a third scan of an unchanged folder, and does not even open the files', async () => {
    const f = fakes([file('i1.dcm')]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    f.hashed.length = 0;
    f.sent.length = 0;
    const again = await sweep(f.state, cfg(), f.deps);
    expect(again).toMatchObject({ ready: 1, batches: 0, files: 0 });
    expect(f.hashed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it('sends only the new file when a folder grows, into a second batch', async () => {
    const files = [file('i1.dcm')];
    const f = fakes(files);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(f.opened.map((o) => o.batchId)).toEqual(['b-1']);

    files.push(file('i2.dcm'));
    // The listing moved, so this pass only notices. A study that arrives instance by instance
    // is taken once, when the writer stops, not once per instance.
    const waiting = await sweep(f.state, cfg(), f.deps);
    expect(waiting).toMatchObject({ ready: 0, batches: 0 });
    const acting = await sweep(f.state, cfg(), f.deps);
    expect(f.opened.map((o) => o.batchId)).toEqual(['b-1', 'b-2']);
    expect(acting).toMatchObject({ files: 1 });
    expect(folderOf(f).files['i2.dcm']!.batchId).toBe('b-2');
  });

  it('does not re-send a file that was merely copied or touched, with the same bytes', async () => {
    const files = [file('i1.dcm')];
    const f = fakes(files);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    files[0]!.mtimeMs = 2_000;
    f.sent.length = 0;
    f.hashed.length = 0;
    // The listing moved, so one scan only notices it.
    await sweep(f.state, cfg(), f.deps);
    await sweep(f.state, cfg(), f.deps);
    // It had to be opened to learn the bytes were the same, and then it stayed on the disk.
    expect(f.hashed).toEqual(['i1.dcm']);
    expect(f.sent).toHaveLength(0);
    expect(folderOf(f).files['i1.dcm']).toMatchObject({ mtimeMs: 2_000, status: 'uploaded' });
  });

  it('quarantines what is not a DICOM object and never offers it again', async () => {
    const f = fakes([file('report.pdf')], {
      put: async () => ({ ok: true, fileId: 'f', bytes: 100, kind: 'non_dicom', quarantined: true }),
    });
    await prime(f);
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s).toMatchObject({ quarantined: 1 });
    expect(folderOf(f).files['report.pdf']).toMatchObject({ status: 'quarantined', errorCode: 'not_dicom' });
    f.sent.length = 0;
    f.hashed.length = 0;
    await sweep(f.state, cfg(), f.deps);
    expect(f.hashed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });
});

describe('a pass that does not finish', () => {
  it('stops the folder on a connection that died, holds it, then resumes the same batch', async () => {
    let dropOnce = true;
    const f = fakes([file('i1.dcm'), file('i2.dcm')], {
      put: async (name) => {
        // One bad write, then the network is fine: what is being measured is the resume, not
        // whether a hang-up can be simulated forever.
        if (name === 'i2.dcm' && dropOnce) {
          dropOnce = false;
          throw new Error('socket hang up');
        }
        return { ok: true, fileId: 'f', bytes: 100, kind: 'dicom', quarantined: false };
      },
    });
    await prime(f);
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s.files).toBe(1);
    expect(f.sealed).toHaveLength(0);
    expect(f.log.join(' ')).toMatch(/will not be sent twice/);
    expect(folderOf(f)).toMatchObject({ failures: 1 });

    // Sweeping again immediately has to be refused by its own schedule.
    const blocked = await sweep(f.state, cfg(), f.deps);
    expect(blocked).toMatchObject({ ready: 0, waiting: 1, batches: 0 });

    f.advance(5);
    f.sent.length = 0;
    f.attempts.length = 0;
    const resumed = await sweep(f.state, cfg(), f.deps);
    // No second batch for one study: the resume goes into the batch that was already open.
    expect(f.opened.map((o) => o.batchId)).toEqual(['b-1']);
    expect(f.attempts.map((x) => x.name)).toEqual(['i2.dcm']);
    expect(f.sent.map((x) => x.name)).toEqual(['i2.dcm']);
    expect(f.sent[0]!.batchId).toBe('b-1');
    expect(f.sealed).toEqual(['b-1']);
    expect(resumed).toMatchObject({ files: 1 });
    expect(folderOf(f)).toMatchObject({ failures: 0, nextAttemptAt: null });
  });

  it('waits longer after each failure instead of hammering a dead api', async () => {
    const f = fakes([file('i1.dcm')], { put: async () => { throw new Error('no route to host'); } });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      f.settle();
      await sweep(f.state, cfg(['--once']), f.deps);
      const record = folderOf(f);
      delays.push(record.nextAttemptAt! - f.clock());
      expect(record.failures).toBe(attempt);
      // Arrive exactly at the scheduled moment so the next failure is measured, not skipped.
      f.advance((record.nextAttemptAt! - f.clock()) / 1000);
    }
    expect(delays).toEqual([5000, 15000, 60000, 300000]);
  });

  it('keeps going after one file is refused, and re-offers only that file', async () => {
    const f = fakes([file('i1.dcm'), file('i2.dcm')], {
      put: async (name) => {
        if (name === 'i1.dcm') throw new AgentHttpError(422, 'sha256_mismatch', {});
        return { ok: true, fileId: 'f', bytes: 100, kind: 'dicom', quarantined: false };
      },
    });
    await prime(f);
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s).toMatchObject({ refused: 1, files: 1 });
    expect(f.sent.map((x) => x.name)).toEqual(['i2.dcm']);
    expect(folderOf(f).files['i1.dcm']).toMatchObject({ status: 'refused', errorCode: 'sha256_mismatch' });

    f.sent.length = 0;
    f.attempts.length = 0;
    f.opened.length = 0;
    await sweep(f.state, cfg(), f.deps);
    // Only the refused file is offered again, and it goes into a fresh batch because the first
    // one was sealed with what it took.
    expect(f.opened.map((o) => o.batchId)).toEqual(['b-2']);
    expect(f.attempts.map((x) => x.name)).toEqual(['i1.dcm']);
    expect(f.sent).toHaveLength(0);
    expect(folderOf(f).files['i2.dcm']!.status).toBe('uploaded');
  });

  it('closes a batch the server says holds no images rather than leaving it open forever', async () => {
    const f = fakes([file('notes.txt')], {
      put: async () => ({ ok: true, fileId: 'f', bytes: 100, kind: 'non_dicom', quarantined: true }),
      sealCode: 'no_dicom_files_received',
    });
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(folderOf(f).batches[0]!.sealed).toBe(true);
    expect(f.log.join(' ')).toMatch(/held no DICOM files/);
    const next = await sweep(f.state, cfg(), f.deps);
    expect(next.batches).toBe(0);
  });

  it('reports an unreadable watch folder without losing what it already sent', async () => {
    const f = fakes([file('i1.dcm')]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(folderOf(f).files['i1.dcm']).toMatchObject({ status: 'uploaded' });
    f.deps.list = () => { throw new Error('EACCES: permission denied'); };
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s.folders).toBe(0);
    expect(f.log.join(' ')).toMatch(/watch folder unreadable/);
    // The cursor is untouched by a failed scan: an SMB share that drops its handle is not a
    // reason to forget which studies already went.
    expect(folderOf(f).files['i1.dcm']).toBeDefined();
  });
});

describe('what leaves the machine', () => {
  it('never prints the folder name, because on a modality PC the folder is the patient', async () => {
    const f = fakes([file('i1.dcm', { folder: 'KAVITA RAO CT HEAD' })]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(f.log.join(' ')).not.toContain('KAVITA');
    // The cursor has to keep the path to do its job; the console must not.
    expect(Object.keys(f.state.folders)).toContain('KAVITA RAO CT HEAD');
  });

  it('prints real names only when the operator asks for them', async () => {
    const c = cfg(['--log-names']);
    const f = fakes([file('i1.dcm', { folder: 'KAVITA RAO' })]);
    await prime(f, c);
    await sweep(f.state, c, f.deps);
    expect(f.log.join(' ')).toContain('KAVITA RAO');
  });

  it('sends the hints the operator’s template derives, and no others', async () => {
    const c = cfg(['--hints', '{accession}-{date}']);
    const f = fakes([file('i1.dcm', { folder: 'ACC-4477-20261010' })]);
    await prime(f, c);
    await sweep(f.state, c, f.deps);
    expect(f.opened[0]!.hints).toMatchObject({
      accessionHint: 'ACC-4477', studyDateHint: '20261010', modalityHint: null,
    });
  });

  it('sends nothing at all in a dry run, and says what it would have done', async () => {
    const c = cfg(['--dry-run']);
    const f = fakes([file('i1.dcm'), file('i2.dcm')]);
    await prime(f, c);
    const s = await sweep(f.state, c, f.deps);
    expect(f.opened).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(s.batches).toBe(1);
    expect(f.log.join(' ')).toMatch(/would send 2 file\(s\), 200 bytes/);
  });

  it('splits a folder over the byte cap and numbers the parts', async () => {
    const c = cfg(['--max-bytes-per-batch', '1000']);
    const f = fakes([file('i1.dcm', { bytes: 600 }), file('i2.dcm', { bytes: 600 })]);
    await prime(f, c);
    await sweep(f.state, c, f.deps);
    expect(f.opened.map((o) => o.batchId)).toEqual(['b-1', 'b-2']);
    expect(f.log.join(' ')).toMatch(/part 1 of 2/);
    expect(f.sealed).toEqual(['b-1', 'b-2']);
  });

  it('keeps two studies in two batches', async () => {
    const f = fakes([file('i1.dcm', { folder: 'A' }), file('i2.dcm', { folder: 'B' })]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(f.opened.map((o) => o.filesExpected)).toEqual([1, 1]);
    expect(f.sealed).toEqual(['b-1', 'b-2']);
    expect(f.state.folders['A']!.files['i1.dcm']!.batchId).toBe('b-1');
    expect(f.state.folders['B']!.files['i2.dcm']!.batchId).toBe('b-2');
  });

  it('counts the folders it saw', async () => {
    const f = fakes([file('i1.dcm', { folder: 'A' }), file('i2.dcm', { folder: 'B' })]);
    const s = await sweep(f.state, cfg(), f.deps);
    expect(s.folders).toBe(2);
  });
});

describe('the cursor file itself', () => {
  it('resumes a restart from what it wrote, not from what the folder looks like', async () => {
    const f = fakes([file('i1.dcm'), file('i2.dcm')]);
    await prime(f);
    await sweep(f.state, cfg(), f.deps);
    expect(f.sent.map((x) => x.name)).toEqual(['i1.dcm', 'i2.dcm']);

    const cursor = path.join(HOME, 'restart-cursor.json');
    saveState(cursor, f.state);
    // A new process, a new sweep, the same folder on disk: the only thing that can tell it that
    // these two files already went is the cursor, because nothing was deleted from the folder.
    const revived = loadState(cursor, HOME);
    f.sent.length = 0;
    f.hashed.length = 0;
    f.opened.length = 0;
    const after = await sweep(revived, cfg(), f.deps);
    expect(after).toMatchObject({ ready: 1, batches: 0, files: 0 });
    expect(f.hashed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });
});
