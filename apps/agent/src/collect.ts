import { createHash } from 'node:crypto';

/**
 * The agent's decisions, with no I/O in them.
 *
 * The whole reason this module exists separately from `main.ts` is that the questions it
 * answers — is this file still being written, is this folder a study, is this name an accession,
 * do I already send this — decide whether a center's images reach the archive once or twice, and
 * each of them is answerable from a list of numbers without a network or a disk.
 */

export type DiscoveredFile = {
  /** Path on the machine running the agent. Never sent to the server. */
  path: string;
  /** The leaf name, which is also the key the server stores it under. */
  name: string;
  /** Forward-slash path of the containing folder, relative to the watch root. */
  folder: string;
  bytes: number;
  mtimeMs: number;
};

/**
 * A file whose last write was this long ago is treated as finished. Settle time is a floor, not
 * a promise: the folder-level check in `folderSignature` is what decides a study is complete,
 * because a modality that wrote the last instance 40 minutes ago and is still exporting the next
 * series would otherwise be sealed halfway.
 */
/** A file once its bytes have been read: the sha256 is what the server is told to expect. */
export type HashedFile = DiscoveredFile & { sha256: string };

export const DEFAULT_SETTLE_SECONDS = 60;

export function isSettled(file: DiscoveredFile, nowMs: number, settleSeconds: number): boolean {
  return nowMs - file.mtimeMs >= settleSeconds * 1000;
}

/** One folder is one study: that is how every modality's export directory is laid out. */
export function groupByFolder<T extends DiscoveredFile>(files: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const file of files) {
    const list = out.get(file.folder);
    if (list) list.push(file);
    else out.set(file.folder, [file]);
  }
  // Deterministic order matters more than it sounds: the batch is named by what arrives first,
  // and a scan that listed files in directory order would re-open a different batch after a
  // reboot for the same study.
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * A short digest of a folder's listing — name, bytes and mtime for every file, sorted. Two
 * consecutive scans with the same signature mean the writer has stopped, whatever it is writing.
 */
export function folderSignature(files: DiscoveredFile[]): string {
  const listed = [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${f.bytes}:${Math.round(f.mtimeMs)}`)
    .join('|');
  return createHash('sha256').update(listed).digest('hex').slice(0, 16);
}

export function isFolderStable(previousSignature: string | null, signature: string): boolean {
  return previousSignature !== null && previousSignature === signature;
}

/**
 * The folder's name goes in the log only as a digest. On a modality PC an export directory is
 * routinely named after the patient, and an agent log is a file that gets emailed to a vendor
 * support desk by whoever is trying to fix it.
 */
export function redactFolder(folder: string): string {
  return createHash('sha256').update(folder).digest('hex').slice(0, 10);
}

export type TemplatePart = { kind: 'text'; value: string } | { kind: 'accession' | 'date' | 'modality' };

/**
 * The site's own naming convention, stated by the operator, is the only thing the hints are
 * derived from — `--hints "{accession}-{date}"` against a folder called `ACC-4477-20261010`.
 *
 * An unknown token is an error rather than a literal, because `{patient}` would otherwise
 * silently capture a patient's name into a column other users of the tenant can read. There is
 * deliberately no patient, MRN or name token to ask for.
 */
export function parseTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let rest = input;
  while (rest.length > 0) {
    const open = rest.indexOf('{');
    if (open === -1) {
      parts.push({ kind: 'text', value: rest });
      break;
    }
    if (open > 0) parts.push({ kind: 'text', value: rest.slice(0, open) });
    const close = rest.indexOf('}', open);
    if (close === -1) throw new Error(`unclosed token in hint template: ${rest.slice(open, open + 20)}`);
    const token = rest.slice(open + 1, close);
    // Only these three, and the list is asserted rather than trusted: the person adding the
    // fourth token is adding a way to leak, so they have to say so here as well.
    if (token === 'accession' || token === 'date' || token === 'modality') parts.push({ kind: token });
    else throw new Error(`unknown token in hint template: {${token}} (allowed: accession, date, modality)`);
    rest = rest.slice(close + 1);
  }
  return parts;
}

const ACCESSION = /^[A-Z0-9][A-Z0-9._-]{2,63}$/;

const SHAPES: Record<'accession' | 'date' | 'modality', string> = {
  accession: '[A-Za-z0-9._-]+',
  date: '\\d{8}|\\d{4}-\\d{2}-\\d{2}',
  modality: '[A-Za-z]{2,4}',
};

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn the operator’s template into one anchored match over the folder’s leaf name.
 *
 * Each token carries its own shape rather than "anything up to the next literal", because an
 * accession can contain the separator: `{accession}-{date}` against `ACC-4477-20261010` splits
 * correctly only when the date is *known* to be eight digits, so the engine can hand the second
 * dash back to the accession. A template that does not match the name at all yields no hints —
 * never a partial guess, because a wrong accession on a batch would link images to somebody
 * else’s order rather than parking them in the orphan queue.
 */
export function hintsMatcher(parts: TemplatePart[]): RegExp {
  const source = parts.map((part) => (part.kind === 'text'
    ? escapeLiteral(part.value)
    : `(?<${part.kind}>${SHAPES[part.kind]})`)).join('');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * A captured accession has to look like one. An export folder called `KAVITA RAO` matched a
 * `{accession}` token as readily as `ACC-4477` does, and a wrong hint is not a missing hint: the
 * server would link images to somebody else's order rather than parking them in the orphan
 * queue. So a digit is required, and spaces are not in the character set.
 */
export function plausibleAccession(value: string): string | null {
  const up = value.trim().toUpperCase();
  if (!ACCESSION.test(up) || !/[0-9]/.test(up)) return null;
  return up;
}

/** `YYYYMMDD`, the only date form any DICOM writer puts in a folder name, with real ranges. */
export function plausibleDate(value: string): string | null {
  const digits = value.trim().replace(/[^0-9]/g, '');
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (year < 1970 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return digits;
}

export function plausibleModality(value: string): string | null {
  const up = value.trim().toUpperCase();
  return /^[A-Z]{2,4}$/.test(up) ? up : null;
}

export type Hints = {
  accessionHint: string | null;
  studyDateHint: string | null;
  modalityHint: string | null;
};

/**
 * Apply the operator's template to one folder. Anything that does not validate is dropped rather
 * than guessed, and the leaf name — not the whole relative path — is what is matched, so a parent
 * directory called `2026-10` cannot supply a study date.
 */
export function hintsFromFolder(folder: string, parts: TemplatePart[]): Hints {
  const leaf = folder.split('/').pop() ?? folder;
  const match = hintsMatcher(parts).exec(leaf);
  if (match === null) return { accessionHint: null, studyDateHint: null, modalityHint: null };
  const groups = match.groups ?? {};
  return {
    accessionHint: groups.accession === undefined ? null : plausibleAccession(groups.accession),
    studyDateHint: groups.date === undefined ? null : plausibleDate(groups.date),
    modalityHint: groups.modality === undefined ? null : plausibleModality(groups.modality),
  };
}

export type BatchPlan<T extends DiscoveredFile = DiscoveredFile> = {
  folder: string;
  files: T[];
  bytes: number;
  /** Which of this folder's batches this is, and how many the folder was split into. */
  part: number;
  parts: number;
};

/**
 * Chunk a folder's files into batches that fit the server's declared limits. A study bigger than
 * the cap is split rather than refused, because a 4,001-instance breast MRI is a real study and
 * the alternative is that the center stops being able to send it.
 *
 * Generic over the file type so a caller that has already hashed its files does not lose that
 * fact at the boundary — the sha256 has to survive to the PUT.
 */
export function planBatches<T extends DiscoveredFile>(
  files: T[], limits: { maxFiles: number; maxBytes: number },
): BatchPlan<T>[] {
  const byFolder = groupByFolder(files);
  const plans: BatchPlan<T>[] = [];
  for (const [folder, list] of byFolder) {
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    const chunks: T[][] = [];
    let current: T[] = [];
    let bytes = 0;
    for (const file of sorted) {
      // A single file over the batch cap is not sendable at all; it goes in its own batch and
      // the server answers 422, which is a truth the operator can act on, rather than being
      // dropped here where nobody would see it.
      if (current.length > 0 && (current.length + 1 > limits.maxFiles || bytes + file.bytes > limits.maxBytes)) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(file);
      bytes += file.bytes;
    }
    if (current.length > 0) chunks.push(current);
    chunks.forEach((chunk, index) => {
      plans.push({
        folder,
        files: chunk,
        bytes: chunk.reduce((sum, f) => sum + f.bytes, 0),
        part: index + 1,
        parts: chunks.length,
      });
    });
  }
  return plans;
}

const LADDER_SECONDS = [5, 15, 60, 300, 900];

/**
 * How long to leave a failed folder alone. An agent on a modality PC outlives most network
 * blips, and retrying every 20 seconds against an api that is down writes a log nobody can read
 * and keeps the connection churning on a machine that is also acquiring patients.
 */
export function backoffSeconds(attempt: number): number {
  if (attempt <= 0) return 0;
  return LADDER_SECONDS[Math.min(attempt, LADDER_SECONDS.length) - 1] ?? 900;
}
