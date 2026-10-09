export type Violation = { field: string; message: string };
export type ValidationResult = { ok: boolean; violations: Violation[] };

export const LIMITS = {
  patientMrnMax: 64,
  patientNameMax: 160,
  accessionMax: 64,
  indicationMax: 2000,
  freeTextMax: 500,
  // A single instance file over 2 GB is not a study, it is a mistake or an attack.
  fileBytesMax: 512 * 1024 * 1024,
  batchFilesMax: 4000,
  batchBytesMax: 8 * 1024 * 1024 * 1024,
  // Zip-bomb guards. A center sending a compressed study is normal; a 40 000-entry
  // archive or a 20 GB expansion is not, and the worker would discover it by
  // exhausting the NAS's memory.
  zipEntriesMax: 20_000,
  zipUncompressedMax: 4 * 1024 * 1024 * 1024,
} as const;

const DICOM_DATE = /^\d{8}$/;
const MODALITY = /^[A-Z]{2,4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Both validators take `unknown` because they are called straight from request
// bodies: a JSON field can arrive as a number, an object or an array, and the
// check has to say so rather than throw on a cast.
export const validDicomDate = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return true;
  // Same rule as dob above, and for the same reason: a dashed date is not a
  // malformed date, it is a different date.
  return typeof value === 'string' && (DICOM_DATE.test(value) || ISO_DATE.test(value));
};

export const validModality = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && MODALITY.test(value.trim().toUpperCase());
};

export function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    // \p{Cc} is the Unicode control-character class: a stray CR or NUL must not
    // survive into a report or an AE title, where one CR forges a line in a
    // printed signature block.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

// A center's MRN is the key patients are found by, so it is normalised once, here:
// trimmed, case-folded and stripped of the punctuation that a receptionist types
// and the billing export does not expect.
export function normaliseMrn(value: unknown): string {
  return cleanText(value, LIMITS.patientMrnMax).toUpperCase().replace(/\s+/g, '');
}

export function validatePatientInput(input: {
  mrn?: unknown; fullName?: unknown; gender?: unknown; dob?: unknown; phone?: unknown;
}): ValidationResult {
  const violations: Violation[] = [];
  if (!normaliseMrn(input.mrn)) violations.push({ field: 'mrn', message: 'required' });
  if (cleanText(input.fullName, LIMITS.patientNameMax).length < 2) {
    violations.push({ field: 'fullName', message: 'at least 2 characters' });
  }
  const gender = String(input.gender ?? 'U').trim().toUpperCase();
  if (!['M', 'F', 'X', 'U'].includes(gender)) {
    violations.push({ field: 'gender', message: 'must be M, F, X or U' });
  }
  const dob = String(input.dob ?? '').trim();
  // '12-04-1978' stripped of separators reads as 12041978, which is a perfectly
  // valid-looking DICOM date for a different day. Accept only an unambiguous form.
  if (dob && !DICOM_DATE.test(dob) && !ISO_DATE.test(dob)) {
    violations.push({ field: 'dob', message: 'must be YYYYMMDD or YYYY-MM-DD' });
  }
  const phone = cleanText(input.phone, 20);
  if (phone && !/^[+0-9 ()-]{6,20}$/.test(phone)) {
    violations.push({ field: 'phone', message: 'digits, +, spaces, parentheses and dashes only' });
  }
  return { ok: violations.length === 0, violations };
}

export function validateOrderInput(input: {
  accessionNumber?: unknown; patientId?: unknown; modalityCode?: unknown;
  subSpecialtyCode?: unknown; priority?: unknown; scheduledDate?: unknown;
  clinicalIndication?: unknown; referringName?: unknown; siteId?: unknown;
}): ValidationResult {
  const violations: Violation[] = [];
  const acc = cleanText(input.accessionNumber, LIMITS.accessionMax);
  if (acc.length < 3) violations.push({ field: 'accessionNumber', message: 'at least 3 characters' });
  if (!Number.isInteger(Number(input.patientId))) {
    violations.push({ field: 'patientId', message: 'must reference an existing patient' });
  }
  if (!validModality(input.modalityCode)) {
    violations.push({ field: 'modalityCode', message: '2-4 uppercase letters, e.g. CT, MR, US, DX' });
  }
  const priority = String(input.priority ?? '').trim().toLowerCase();
  if (!['stat', 'urgent', 'routine'].includes(priority)) {
    violations.push({ field: 'priority', message: 'stat, urgent or routine' });
  }
  if (!validDicomDate(input.scheduledDate)) {
    violations.push({ field: 'scheduledDate', message: 'must be YYYYMMDD' });
  }
  if (input.siteId !== undefined && input.siteId !== null && !Number.isInteger(Number(input.siteId))) {
    violations.push({ field: 'siteId', message: 'must be an integer' });
  }
  const indication = cleanText(input.clinicalIndication, LIMITS.indicationMax);
  if (indication.length > LIMITS.indicationMax) {
    violations.push({ field: 'clinicalIndication', message: `max ${LIMITS.indicationMax} characters` });
  }
  return { ok: violations.length === 0, violations };
}

// A filename arriving from a center's agent is untrusted input, and the staging
// directory sits on the same volume as the archive. So: strip any path, reject
// anything that is not a conservative character set, and never let the caller
// choose where a byte lands.
export function safeFilename(value: unknown): string | null {
  const base = String(value ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

export type FileKind = 'dcm' | 'zip' | 'non_dicom';

export function sniffKind(head: Uint8Array): FileKind {
  if (head.length >= 132) {
    // DICOM Part-10: "DICM" at byte offset 128 after a 128-byte preamble.
    if (head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d) return 'dcm';
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return 'zip';
  }
  return 'non_dicom';
}

export function validateTokenShape(value: unknown): ValidationResult {
  const v = String(value ?? '');
  const ok = /^[A-Za-z0-9_-]{24,128}$/.test(v);
  return { ok, violations: ok ? [] : [{ field: 'token', message: '24-128 url-safe characters' }] };
}
