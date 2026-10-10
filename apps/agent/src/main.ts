import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@telrad/shared';
import { AgentClient, AgentHttpError } from './client.js';
import {
  backoffSeconds, DEFAULT_SETTLE_SECONDS, folderSignature, groupByFolder, hintsFromFolder,
  isSettled, parseTemplate, planBatches, redactFolder,
  type DiscoveredFile, type HashedFile, type TemplatePart,
} from './collect.js';
import {
  folderRecord, isDueAt, loadState, saveState, STATE_FILENAME, unchangedSince,
  type AgentState, type BatchRecord, type FolderRecord,
} from './state.js';

/**
 * The site upload agent: watch the folder a modality exports to and get those images into the
 * archive exactly once.
 *
 * It exists because the alternative is a person. A center without a PACS has a console with a
 * "write to folder" button, and every step between that folder and the archive that a human
 * performs is a step that goes missing at 2 a.m. on a Sunday. The upload endpoints have been
 * proven since P1; this is the thing a site installs on its own machine to call them.
 *
 * Two rules shape everything below. Nothing is deleted from the watch folder — the export is the
 * center's copy until the archive confirms the study, so the agent remembers instead of eating
 * its input. And a folder's name is not printed: export directories are routinely named after the
 * patient, and an agent log is the file somebody attaches to a support email.
 */

export type Config = {
  watch: string;
  api: string;
  tokenFile: string | null;
  state: string;
  intervalSeconds: number;
  settleSeconds: number;
  timeoutMs: number;
  maxBytesPerBatch: number;
  hints: TemplatePart[] | null;
  once: boolean;
  dryRun: boolean;
  allowInsecureHttp: boolean;
  logNames: boolean;
};

const USAGE = `usage: telrad-agent --watch DIR (--api URL | TELRAD_API_URL) [options]

  --watch DIR             the folder the modality exports to (required)
  --api URL               the api origin, https unless --allow-insecure-http
  --token-file PATH       file holding the site token from POST /v1/sites/:id/tokens
  --state PATH            the cursor file (default: <watch>/${STATE_FILENAME})
  --interval SECONDS      how often to scan in the loop (default 20)
  --settle SECONDS        a file last written this long ago is treated as finished (default ${DEFAULT_SETTLE_SECONDS})
  --hints TEMPLATE        derive batch hints from the folder name, e.g. --hints "{accession}-{date}"
                          tokens: {accession} {date} {modality}. There is no patient token.
  --max-bytes-per-batch N split a folder into batches of at most N bytes
  --timeout MS            per-request timeout (default 120000)
  --once                  one pass and exit — for cron, and for the verification run
  --dry-run               scan and report what would go, send nothing
  --allow-insecure-http   permit a cleartext api origin
  --log-names             print real folder names instead of their digest

The token is never taken as a command-line value: argv is readable by every other account on a
shared workstation and it lands in shell history. Use --token-file (mode 600) or TELRAD_AGENT_TOKEN.`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const num = (raw: string, name: string): number => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number, got ${raw}`);
    return v;
  };

  const cfg: Config = {
    watch: '',
    api: env.TELRAD_API_URL ?? '',
    tokenFile: null,
    state: '',
    intervalSeconds: 20,
    settleSeconds: DEFAULT_SETTLE_SECONDS,
    timeoutMs: 120_000,
    maxBytesPerBatch: LIMITS.batchBytesMax,
    hints: null,
    once: false,
    dryRun: false,
    allowInsecureHttp: env.TELRAD_ALLOW_INSECURE_HTTP === '1',
    logNames: false,
  };

  // A cursor over argv rather than a `for` with an increment inside the body. The first version
  // of this loop advanced twice for every flag that took a value and once for every flag that
  // did not, so `--once --dry-run` silently dropped `--dry-run` and sent real files in what the
  // operator believed was a rehearsal. It was caught by the live run, on the second flag tried.
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    i += 1;
    const value = (): string => {
      const v = argv[i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };

    if (arg === '--watch') cfg.watch = value();
    else if (arg === '--api') cfg.api = value();
    else if (arg === '--token') {
      throw new Error('--token would put the credential in the process list.'
        + ' Use --token-file PATH or TELRAD_AGENT_TOKEN.');
    } else if (arg === '--token-file') cfg.tokenFile = value();
    else if (arg === '--state') cfg.state = value();
    else if (arg === '--interval') cfg.intervalSeconds = num(value(), '--interval');
    else if (arg === '--settle') cfg.settleSeconds = num(value(), '--settle');
    else if (arg === '--timeout') cfg.timeoutMs = num(value(), '--timeout');
    else if (arg === '--max-bytes-per-batch') {
      cfg.maxBytesPerBatch = num(value(), '--max-bytes-per-batch');
    } else if (arg === '--hints') cfg.hints = parseTemplate(value());
    else if (arg === '--once') cfg.once = true;
    else if (arg === '--dry-run') cfg.dryRun = true;
    else if (arg === '--allow-insecure-http') cfg.allowInsecureHttp = true;
    else if (arg === '--log-names') cfg.logNames = true;
    else if (arg === '--help' || arg === '-h') throw new UsageRequested(USAGE);
    else throw new Error(`unknown argument ${arg}\n\n${USAGE}`);
  }

  if (cfg.watch === '') throw new Error(`--watch is required\n\n${USAGE}`);
  if (cfg.api === '') throw new Error(`no api given: --api URL or TELRAD_API_URL\n\n${USAGE}`);
  if (cfg.state === '') cfg.state = path.join(cfg.watch, STATE_FILENAME);
  // Resolved once, here: the cursor stores absolute paths, and a relative `--watch .` means
  // something different to the next cron entry that runs from a different directory.
  cfg.watch = path.resolve(cfg.watch);
  return cfg;
}

/** `--help` is a success that reads like an error, so it is typed rather than string-matched. */
export class UsageRequested extends Error {}

export function resolveToken(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (cfg.tokenFile !== null) {
    const token = readFileSync(cfg.tokenFile, 'utf8').trim();
    if (token === '') throw new Error(`${cfg.tokenFile} is empty`);
    return token;
  }
  const fromEnv = (env.TELRAD_AGENT_TOKEN ?? '').trim();
  if (fromEnv === '') throw new Error('no token: set TELRAD_AGENT_TOKEN or pass --token-file PATH');
  return fromEnv;
}

export function listStudies(root: string): DiscoveredFile[] {
  if (!existsSync(root)) throw new Error(`--watch ${root} does not exist`);
  const out: DiscoveredFile[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // A folder that will not list is a scanned-and-moved-on, not a crash: an SMB export share
      // drops its handle routinely, and the next scan works. The count line says what was seen.
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === STATE_FILENAME || name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        out.push({
          path: full,
          name,
          folder: path.relative(root, path.dirname(full)).split(path.sep).join('/'),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  walk(root);
  return out;
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk: Buffer | string) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

export type SweepSummary = {
  folders: number;
  ready: number;
  waiting: number;
  batches: number;
  files: number;
  bytes: number;
  quarantined: number;
  refused: number;
};

/** Everything a sweep touches that a test wants to hold still. */
export type SweepDeps = {
  client: Pick<AgentClient, 'openBatch' | 'putFile' | 'sealBatch' | 'getBatch'>;
  now: () => number;
  log: (line: string) => void;
  list: (root: string) => DiscoveredFile[];
  sha256: (file: string) => Promise<string>;
};

/**
 * One pass over the watch folder.
 *
 * The order is deliberate: read the folder, decide what is finished, then ask what has not
 * already gone. Files whose size and mtime match the cursor are never opened, which is what makes
 * it safe to run this every twenty seconds beside a scanner that is acquiring a patient.
 */
export async function sweep(state: AgentState, cfg: Config, deps: SweepDeps): Promise<SweepSummary> {
  const summary: SweepSummary = {
    folders: 0, ready: 0, waiting: 0, batches: 0, files: 0, bytes: 0, quarantined: 0, refused: 0,
  };
  const now = deps.now();
  let seen: DiscoveredFile[];
  try {
    seen = deps.list(cfg.watch);
  } catch (err) {
    deps.log(`watch folder unreadable: ${(err as Error).message}`);
    return summary;
  }
  summary.folders = groupByFolder(seen).size;

  for (const [folder, files] of groupByFolder(seen)) {
    const record = state.folders[folder] ?? folderRecord();
    state.folders[folder] = record;
    const shown = cfg.logNames ? folder : redactFolder(folder);

    const signature = folderSignature(files);
    const unsettled = files.filter((f) => !isSettled(f, now, cfg.settleSeconds));
    const stable = cfg.once || isFolderStableThisPass(record, signature);
    record.lastSignature = signature;
    if (unsettled.length > 0 || !stable) {
      summary.waiting += 1;
      if (unsettled.length > 0) {
        deps.log(`${shown}: ${files.length} file(s), ${unsettled.length} written within ${cfg.settleSeconds}s`
          + ' — not taking it yet');
      } else {
        deps.log(`${shown}: ${files.length} file(s), waiting for a second scan that agrees`);
      }
      continue;
    }
    if (!isDueAt(record, now)) {
      summary.waiting += 1;
      continue;
    }
    summary.ready += 1;

    const pending = await collectPending(record, files, deps);

    // A batch left open from an earlier pass is finished first, and finished by its own id: two
    // half-batches for one study read to the worker as two studies nobody ordered.
    if (!cfg.dryRun) {
      for (const batch of record.batches.filter((b) => !b.sealed)) {
        const inside = countInBatch(record, batch.batchId);
        const take = pending.splice(0, Math.max(batch.filesExpected - inside, 0));
        if (!await sendAll(record, batch.batchId, take, deps, cfg, shown, summary)) break;
        if (!await finishBatch(record, batch, deps, cfg, shown)) break;
        summary.batches += 1;
      }
    }
    if (!cfg.dryRun && record.batches.some((b) => !b.sealed)) continue;

    if (pending.length === 0) continue;

    const hints = cfg.hints === null
      ? { accessionHint: null, studyDateHint: null, modalityHint: null }
      : hintsFromFolder(folder, cfg.hints);

    for (const plan of planBatches(pending, {
      maxFiles: LIMITS.batchFilesMax, maxBytes: cfg.maxBytesPerBatch,
    })) {
      if (cfg.dryRun) {
        deps.log(`${shown}: would send ${plan.files.length} file(s), ${plan.bytes} bytes`
          + (plan.parts > 1 ? ` (part ${plan.part} of ${plan.parts})` : ''));
        summary.batches += 1;
        continue;
      }
      let opened;
      try {
        opened = await deps.client.openBatch({
          filesExpected: plan.files.length, bytesDeclared: plan.bytes, ...hints,
        });
      } catch (err) {
        failFolder(record, deps, cfg, shown, err);
        break;
      }
      const batch: BatchRecord = {
        batchId: opened.batchId, sealed: false, sealedAt: null, filesExpected: plan.files.length,
      };
      record.batches.push(batch);
      summary.batches += 1;
      deps.log(`${shown}: batch ${opened.batchId} open for ${plan.files.length} file(s)`
        + (plan.parts > 1 ? ` (part ${plan.part} of ${plan.parts})` : '')
        + (hints.accessionHint !== null ? `, accession hint ${hints.accessionHint}` : ''));
      if (!await sendAll(record, opened.batchId, plan.files, deps, cfg, shown, summary)) break;
      if (!await finishBatch(record, batch, deps, cfg, shown)) break;
    }
  }

  return summary;
}

/**
 * Two consecutive scans that list the same files at the same sizes and times is what "the writer
 * has stopped" means. The settle window alone cannot say it: a CT that wrote its last slice forty
 * minutes ago and is still exporting the next series would be sealed halfway, and a half-studied
 * patient is worse than a late one.
 */
function isFolderStableThisPass(record: FolderRecord, signature: string): boolean {
  return record.lastSignature !== null && record.lastSignature === signature;
}

/** Hash only what might be new, and hand back the files that are not on the server yet. */
async function collectPending(
  record: FolderRecord, files: DiscoveredFile[], deps: SweepDeps,
): Promise<HashedFile[]> {
  const pending: HashedFile[] = [];
  for (const file of files) {
    const known = record.files[file.name];
    if (unchangedSince(known, file)) continue;
    const sha256 = await deps.sha256(file.path);
    if (known !== undefined && known.sha256 === sha256 && known.status !== 'refused') {
      // Same bytes, different mtime: the folder was copied or touched, not re-exported.
      record.files[file.name] = { ...known, bytes: file.bytes, mtimeMs: file.mtimeMs };
      continue;
    }
    pending.push({ ...file, sha256 });
  }
  return pending;
}

function countInBatch(record: FolderRecord, batchId: string): number {
  return Object.values(record.files).filter((f) => f.batchId === batchId).length;
}

/**
 * Send a list of files into one batch. Returns false when the folder has to be abandoned for
 * this pass — a connection that did not complete or a 5xx — after recording the failure and its
 * next attempt. A 4xx on one file is that file's problem and does not stop the study.
 */
async function sendAll(
  record: FolderRecord, batchId: string, files: HashedFile[], deps: SweepDeps, cfg: Config,
  shown: string, summary: SweepSummary,
): Promise<boolean> {
  for (const file of files) {
    try {
      const reply = await deps.client.putFile(batchId, file.name, file.path, file.sha256);
      summary.files += 1;
      summary.bytes += file.bytes;
      record.files[file.name] = {
        name: file.name, bytes: file.bytes, mtimeMs: file.mtimeMs, sha256: file.sha256, batchId,
        status: reply.quarantined ? 'quarantined' : 'uploaded',
        errorCode: reply.quarantined ? 'not_dicom' : null,
      };
      if (reply.quarantined) {
        summary.quarantined += 1;
        deps.log(`${shown}: ${file.name} is not a DICOM object — the server quarantined it`);
      }
    } catch (err) {
      if (err instanceof AgentHttpError && err.permanent) {
        summary.refused += 1;
        record.files[file.name] = {
          name: file.name, bytes: file.bytes, mtimeMs: file.mtimeMs, sha256: file.sha256, batchId,
          status: 'refused', errorCode: err.code,
        };
        deps.log(`${shown}: ${file.name} refused — ${err.code}`);
        continue;
      }
      failFolder(record, deps, cfg, shown, err);
      return false;
    }
  }
  return true;
}

/**
 * Seal, then read the batch back. The seal reply is a claim about one moment; the `GET` is what
 * the archive actually holds, and the two are compared rather than trusted.
 */
async function finishBatch(
  record: FolderRecord, batch: BatchRecord, deps: SweepDeps, cfg: Config, shown: string,
): Promise<boolean> {
  if (cfg.dryRun) return true;
  try {
    const sealed = await deps.client.sealBatch(batch.batchId);
    const view = await deps.client.getBatch(batch.batchId);
    batch.sealed = true;
    batch.sealedAt = new Date(deps.now()).toISOString();
    deps.log(`${shown}: batch ${batch.batchId} sealed — server holds stored=${sealed.stored}`
      + ` quarantined=${view.files.filter((f) => f.status === 'quarantined').length}`
      + ` of ${view.files.length} file(s) it received`);
    record.failures = 0;
    record.nextAttemptAt = null;
    return true;
  } catch (err) {
    if (err instanceof AgentHttpError && err.code === 'no_dicom_files_received') {
      // Nothing in it was an image, so sealing can never succeed. Close it locally rather than
      // leaving a batch open forever — an open batch is the state where a study hides.
      batch.sealed = true;
      batch.sealedAt = new Date(deps.now()).toISOString();
      deps.log(`${shown}: batch ${batch.batchId} held no DICOM files and was closed unsent`);
      return true;
    }
    failFolder(record, deps, cfg, shown, err);
    return false;
  }
}

function failFolder(
  record: FolderRecord, deps: SweepDeps, cfg: Config, shown: string, err: unknown,
): void {
  record.failures += 1;
  record.nextAttemptAt = deps.now() + backoffSeconds(record.failures) * 1000;
  const why = err instanceof AgentHttpError ? `${err.status} ${err.code}` : (err as Error).message;
  const already = Object.keys(record.files).length;
  deps.log(`${shown}: stopped (${why}). ${already} file(s) of this folder are recorded on the`
    + ` server already and will not be sent twice. Retrying this folder in`
    + ` ${backoffSeconds(record.failures)}s.`);
}

export async function runOnce(cfg: Config, deps: SweepDeps, state: AgentState): Promise<SweepSummary> {
  try {
    return await sweep(state, cfg, deps);
  } finally {
    // Saved even when a pass threw: the files that did go are the whole reason the cursor
    // exists, and losing it on an unhandled error would send them again.
    saveState(cfg.state, state);
  }
}

async function main(): Promise<number> {
  let cfg: Config;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageRequested) {
      console.log(err.message);
      return 0;
    }
    console.error((err as Error).message);
    return 2;
  }

  let state: AgentState;
  let token: string;
  try {
    state = loadState(cfg.state, cfg.watch);
    token = resolveToken(cfg);
  } catch (err) {
    console.error((err as Error).message);
    return 3;
  }

  let client: AgentClient;
  try {
    client = new AgentClient({
      api: cfg.api, token, timeoutMs: cfg.timeoutMs, allowInsecureHttp: cfg.allowInsecureHttp,
    });
  } catch (err) {
    console.error((err as Error).message);
    return 4;
  }

  const deps: SweepDeps = {
    client, now: () => Date.now(), log: (line) => console.log(line),
    list: listStudies, sha256: sha256OfFile,
  };

  console.log(`telrad agent watch=${redactFolder(cfg.watch)} api=${client.host}`
    + ` settle=${cfg.settleSeconds}s interval=${cfg.once ? 'once' : `${cfg.intervalSeconds}s`}`
    + ` mode=${cfg.dryRun ? 'dry run' : 'send'}`);

  for (;;) {
    try {
      const s = await runOnce(cfg, deps, state);
      console.log(`scan: ${s.folders} folder(s), ${s.ready} ready, ${s.waiting} waiting,`
        + ` ${s.batches} batch(es), ${s.files} file(s) sent, ${s.bytes} bytes,`
        + ` ${s.quarantined} quarantined, ${s.refused} refused`);
    } catch (err) {
      // Anything that escapes the sweep still leaves the loop alive: an agent that dies on an
      // unexpected error stops collecting, and nobody notices until a center asks why Tuesday's
      // studies never arrived.
      console.log(`scan failed: ${(err as Error).message}`);
    }
    if (cfg.once) return 0;
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalSeconds * 1000));
  }
}

const entry = process.argv[1] === undefined ? '' : path.resolve(fileURLToPath(import.meta.url));
if (entry && path.resolve(process.argv[1]!) === entry) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`agent stopped: ${(err as Error).message}`);
    process.exit(1);
  });
}
