import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alreadySent, emptyState, findOpenBatch, folderRecord, isDueAt, loadState, saveState,
  unchangedSince,
} from '../src/state.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'telrad-agent-state-'));
const record = (over: Partial<Parameters<typeof alreadySent>[0]> = {}) => ({
  name: 'i.dcm', bytes: 100, mtimeMs: 1, sha256: 'aaa', batchId: 'b-1',
  status: 'uploaded' as const, errorCode: null, ...over,
});

describe('the cursor round trip', () => {
  it('starts empty when there is no file yet, which is the first run', () => {
    const root = dir();
    expect(loadState(path.join(root, 'state.json'), root)).toEqual(emptyState(root));
  });

  it('survives a write and a read unchanged', () => {
    const root = dir();
    const file = path.join(root, 'state.json');
    const state = emptyState(root);
    state.folders['ACC-1'] = { ...folderRecord(), files: { 'i.dcm': record() } };
    saveState(file, state);
    expect(loadState(file, root)).toEqual(state);
  });

  it('leaves the temporary behind as a rename does, so no half cursor is ever read', () => {
    const root = dir();
    const file = path.join(root, 'state.json');
    saveState(file, emptyState(root));
    // The rename is the atomic part. What must not survive is a `.tmp` that a later scan picks
    // up as a study — and `listStudies` skips that suffix for exactly this reason.
    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow();
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('refuses a cursor it cannot read rather than re-uploading everything', () => {
    const root = dir();
    const file = path.join(root, 'state.json');
    writeFileSync(file, '{ "version": 1, "fold', 'utf8');
    expect(() => loadState(file, root)).toThrow(/not readable JSON/);
  });

  it('refuses a cursor from a different watch folder', () => {
    // Two centers' exports restored onto one disk would otherwise be read as one history, and
    // whichever one the cursor names would be treated as already sent.
    const a = dir();
    const b = dir();
    const file = path.join(a, 'state.json');
    saveState(file, emptyState(a));
    expect(() => loadState(file, b)).toThrow(/different watch root/);
  });

  it('refuses a cursor from a future version instead of guessing at its shape', () => {
    const root = dir();
    const file = path.join(root, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 7, root, folders: {} }), 'utf8');
    expect(() => loadState(file, root)).toThrow(/not a telrad agent cursor/);
  });
});

describe('what counts as already sent', () => {
  it('skips a file whose bytes, size and time all match the record', () => {
    expect(alreadySent(record(), { sha256: 'aaa', bytes: 100, mtimeMs: 1 })).toBe(true);
  });

  it('sends again when the same name holds different bytes', () => {
    // Modalities reuse instance filenames. A name-keyed cursor would silently drop the re-export.
    expect(alreadySent(record(), { sha256: 'bbb', bytes: 100, mtimeMs: 1 })).toBe(false);
  });

  it('sends again when the file was rewritten under the same name and content changed', () => {
    expect(alreadySent(record(), { sha256: 'aaa', bytes: 101, mtimeMs: 2 })).toBe(false);
  });

  it('counts a quarantined file as already sent, because it is on the server already', () => {
    // It is in the batch, it is marked not-DICOM, and offering it a fifth time will not make it
    // an image. The state is finished, not failed — which is why it is not `refused`.
    expect(alreadySent(record({ status: 'quarantined' }), { sha256: 'aaa', bytes: 100, mtimeMs: 1 }))
      .toBe(true);
  });

  it('re-sends what the server refused, because the disk copy may have changed since', () => {
    expect(alreadySent(record({ status: 'refused', errorCode: 'sha256_mismatch' }),
      { sha256: 'aaa', bytes: 100, mtimeMs: 1 })).toBe(false);
  });
});

describe('the cheap test that runs before a file is opened', () => {
  it('matches on size and time alone, which is what keeps a re-scan of history cheap', () => {
    expect(unchangedSince(record(), { bytes: 100, mtimeMs: 1 })).toBe(true);
    expect(unchangedSince(record(), { bytes: 100, mtimeMs: 9 })).toBe(false);
    expect(unchangedSince(undefined, { bytes: 100, mtimeMs: 1 })).toBe(false);
  });

  it('does not trust a record for a file the server refused', () => {
    expect(unchangedSince(record({ status: 'refused' }), { bytes: 100, mtimeMs: 1 })).toBe(false);
  });
});

describe('batches and backoff', () => {
  it('finds the batch a pass left open, which is the one a resume has to fill', () => {
    const folder = folderRecord();
    folder.batches.push({ batchId: 'b-1', sealed: true, sealedAt: 'x', filesExpected: 3 });
    folder.batches.push({ batchId: 'b-2', sealed: false, sealedAt: null, filesExpected: 3 });
    expect(findOpenBatch(folder)?.batchId).toBe('b-2');
  });

  it('is due when nothing was scheduled, and not due before the scheduled moment', () => {
    expect(isDueAt(folderRecord(), 1000)).toBe(true);
    expect(isDueAt({ ...folderRecord(), nextAttemptAt: 2000 }, 1000)).toBe(false);
    expect(isDueAt({ ...folderRecord(), nextAttemptAt: 1000 }, 1000)).toBe(true);
  });
});
