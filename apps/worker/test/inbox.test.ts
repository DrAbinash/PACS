import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOnce, type InboxFile, type InboxStore } from '../src/inbox.js';
import type { OrthancWriter } from '../src/orthanc.js';

let root: string;
const files: InboxFile[] = [];
const marked: { id: string; status: string; instanceId: string | null; error: string | null }[] = [];
const finished: { batchId: string; status: string; error: string | null }[] = [];
const pushed: { bytes: number; labels: string[] }[] = [];

function dicomBytes(marker: number): Buffer {
  const b = Buffer.alloc(200);
  b[128] = 0x44; b[129] = 0x49; b[130] = 0x43; b[131] = 0x4d;
  b[132] = marker;
  return b;
}

function makeStored(name: string, contents: Buffer): InboxFile {
  const storedPath = path.posix.join('b-1', name);
  writeFileSync(path.join(root, 'b-1', name), contents);
  const kind = name.endsWith('.zip') ? 'zip' : 'dcm';
  const file: InboxFile = { id: `f-${name}`, filename: name, storedPath, kind, status: 'stored' };
  files.push(file);
  return file;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'telrad-inbox-'));
  await import('node:fs').then((fs) => fs.mkdirSync(path.join(root, 'b-1'), { recursive: true }));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const writer: OrthancWriter = {
  async pushInstance(bytes, labels) {
    pushed.push({ bytes: bytes.length, labels });
    return { instanceId: `inst-${pushed.length}`, labelError: null };
  },
};

const store: InboxStore = {
  async claimBatch() {
    return { batchId: 'b-1', tenantId: 1, files };
  },
  async markFile(id, status, orthancInstanceId, errorCode) {
    marked.push({ id, status, instanceId: orthancInstanceId, error: errorCode });
  },
  async finishBatch(batchId, status, error) {
    finished.push({ batchId, status, error });
  },
};

describe('drainOnce', () => {
  it('pushes a plain DICOM file and labels it with the batch', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    makeStored('img001.dcm', dicomBytes(1));

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(r).toMatchObject({ batchId: 'b-1', pushed: 1, rejected: 0 });
    expect(pushed[0]!.labels).toEqual(['telrad-batch-b-1']);
    expect(marked[0]).toMatchObject({ id: 'f-img001.dcm', status: 'pushed', instanceId: 'inst-1' });
    expect(finished[0]!.status).toBe('ingested');
  });

  it('records an archived instance as pushed when the node refuses its label', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    makeStored('img002.dcm', dicomBytes(5));

    // The bytes are in the archive; only the batch attribution failed. Marking this
    // rejected would tell the center their study was lost, and the poller would
    // never be asked to resolve it in the orphan queue.
    const refusing: OrthancWriter = {
      async pushInstance() {
        return { instanceId: 'inst-9', labelError: 'label telrad-batch-b-1 refused: 400' };
      },
    };

    const r = await drainOnce(refusing, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(r).toMatchObject({ pushed: 1, rejected: 0, unlabeled: 1 });
    expect(marked[0]).toMatchObject({ status: 'pushed', instanceId: 'inst-9', error: 'label_failed' });
    expect(finished[0]!.status).toBe('ingested');
    expect(finished[0]!.error).toContain('refused');
  });

  it('explodes a zip into its members and pushes each one', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    const zipped = zipSync({ 'a.dcm': dicomBytes(2), 'b.dcm': dicomBytes(3) });
    makeStored('study.zip', Buffer.from(zipped));

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(r!.pushed).toBe(2);
    expect(pushed.map((p) => p.labels[0])).toEqual(['telrad-batch-b-1', 'telrad-batch-b-1']);
  });

  it('refuses a zip member that is not DICOM rather than filing junk into the archive', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    const zipped = zipSync({ 'notes.txt': Buffer.from('just a note, not an image') });
    makeStored('mixed.zip', Buffer.from(zipped));

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(pushed).toHaveLength(0);
    expect(r!.rejected).toBe(1);
    expect(finished[0]!.status).toBe('rejected');
    expect(marked[0]!.error).toBe('entry_not_dicom');
  });

  it('quarantines a non-DICOM file that was never meant to be pushed', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    files.push({ id: 'f-jpg', filename: 'photo.jpg', storedPath: 'b-1/photo.jpg', kind: 'non_dicom', status: 'quarantined' });

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(pushed).toHaveLength(0);
    expect(r!.rejected).toBe(1);
  });

  it('reports a missing staged file instead of pretending it was archived', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    files.push({ id: 'f-gone', filename: 'gone.dcm', storedPath: 'b-1/gone.dcm', kind: 'dcm', status: 'stored' });

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(r!.rejected).toBe(1);
    expect(marked[0]).toMatchObject({ status: 'rejected', error: 'file_missing' });
    expect(r!.error).toContain('gone.dcm');
  });

  it('accepts an inbox root written with forward slashes', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    makeStored('fwd-slash.dcm', dicomBytes(7));

    const r = await drainOnce(writer, store, {
      nodeId: 'n', inboxRoot: root.split(path.sep).join('/'), removeAfterPush: false,
    });

    expect(r!.pushed).toBe(1);
    expect(marked[0]!.status).toBe('pushed');
  });

  it('refuses a stored path that climbs out of the inbox', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    files.push({ id: 'f-escape', filename: 'escape.dcm', storedPath: '../../outside.dcm', kind: 'dcm', status: 'stored' });

    const r = await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: false });

    expect(pushed).toHaveLength(0);
    expect(r!.rejected).toBe(1);
    expect(marked[0]!.error).toBe('unsafe_path');
  });

  it('removes staged bytes only when asked to', async () => {
    pushed.length = 0; marked.length = 0; finished.length = 0; files.length = 0;
    const f = makeStored('cleanup.dcm', dicomBytes(9));

    await drainOnce(writer, store, { nodeId: 'n', inboxRoot: root, removeAfterPush: true });

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(root, f.storedPath))).toBe(false);
  });
});
