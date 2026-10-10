import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The cursor: what this agent has already put on the wire.
 *
 * Deleting the source files after a send would be the simple answer, and it is the wrong one —
 * the modality's export folder is the center's copy until the archive confirms the study, and an
 * agent that eats its input turns a failed night into lost patients. So the agent leaves
 * everything where it is and remembers what it did, in a file next to the watch root.
 */

export type FileRecord = {
  name: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
  batchId: string;
  /**
   * `uploaded` — the server stored it. `quarantined` — the server took it and said it is not
   * DICOM, which is a finished state: the file will never become one by being sent again.
   * `refused` — the server rejected the bytes (a sha256 mismatch, usually a corrupted export),
   * and that one is retried, because the file on disk may have been rewritten since.
   */
  status: 'uploaded' | 'quarantined' | 'refused';
  errorCode: string | null;
};

export type BatchRecord = {
  batchId: string;
  /** Open batches are resumed by the same batch id, so a restart does not start a second copy. */
  sealed: boolean;
  sealedAt: string | null;
  filesExpected: number;
};

export type FolderRecord = {
  batches: BatchRecord[];
  files: Record<string, FileRecord>;
  /** The listing seen on the previous scan. Two identical scans are what "finished" means. */
  lastSignature: string | null;
  failures: number;
  nextAttemptAt: number | null;
};

export type AgentState = {
  version: 1;
  root: string;
  folders: Record<string, FolderRecord>;
};

export const STATE_FILENAME = 'telrad-agent-state.json';

export function emptyState(root: string): AgentState {
  return { version: 1, root, folders: {} };
}

export function folderRecord(): FolderRecord {
  return { batches: [], files: {}, lastSignature: null, failures: 0, nextAttemptAt: null };
}

/**
 * A state file that cannot be read stops the agent. This is the one place where being strict is
 * worth it: the alternative is to treat every folder as unseen and send the center's whole export
 * history a second time, which the server would happily accept as new batches.
 */
export function loadState(file: string, root: string): AgentState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return emptyState(root);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`state file is not readable JSON: ${file}. Fix or move it; the agent will not`
      + ' guess what it already sent, because guessing wrong re-uploads every study in the folder.');
  }
  const state = parsed as Partial<AgentState>;
  if (state.version !== 1 || typeof state.folders !== 'object' || state.folders === null) {
    throw new Error(`state file is not a telrad agent cursor (version ${String(state.version)}): ${file}`);
  }
  // The root is recorded so a cursor moved between machines — a copied folder, a restored
  // backup — cannot be pointed at different contents and call them the same studies.
  if (typeof state.root === 'string' && path.resolve(state.root) !== path.resolve(root)) {
    throw new Error(`state file belongs to a different watch root (${state.root}), not ${root}.`
      + ' Keep one cursor per folder.');
  }
  return { version: 1, root, folders: state.folders as AgentState['folders'] };
}

/**
 * Write-then-rename. An agent killed mid-write on a modality PC that reboots nightly is the
 * normal case, and a half-written JSON cursor would be the end of every resume guarantee below.
 */
export function saveState(file: string, state: AgentState): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Has this exact file already gone? Identity is content plus mtime plus size, not name alone:
 * modalities reuse instance filenames across studies and across re-exports, and a re-exported
 * file with the same name and different bytes has to be sent again.
 */
export function alreadySent(record: FileRecord | undefined, now: {
  sha256: string; bytes: number; mtimeMs: number;
}): boolean {
  if (record === undefined) return false;
  if (record.status === 'refused') return false;
  return record.sha256 === now.sha256 && record.bytes === now.bytes && record.mtimeMs === now.mtimeMs;
}

/**
 * The cheap test, before any file is opened: same name, same size, same mtime as what the cursor
 * says already went. A folder that has sat there for a week is answered by `stat` alone.
 */
export function unchangedSince(
  record: FileRecord | undefined, file: { bytes: number; mtimeMs: number },
): boolean {
  return record !== undefined && record.status !== 'refused'
    && record.bytes === file.bytes && record.mtimeMs === file.mtimeMs;
}

export function findOpenBatch(state: FolderRecord): BatchRecord | undefined {
  return state.batches.find((b) => !b.sealed);
}

export function isDueAt(record: FolderRecord, nowMs: number): boolean {
  return record.nextAttemptAt === null || record.nextAttemptAt <= nowMs;
}
