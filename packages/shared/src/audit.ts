import { createHash, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

// scrypt from node:crypto rather than bcrypt: no native compilation, so a Linux
// CI container and a Windows laptop install the identical tree. Parameters are
// recorded in the hash so they can be raised without a data migration.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

const scrypt = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  nodeScrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, out) =>
    err ? reject(err) : resolve(out));
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [kind, nStr, rStr, pStr, saltB64, keyB64] = stored.split('$');
  if (kind !== 'scrypt' || !nStr || !rStr || !pStr || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, salt);
  return actual.length === expected.length
    && timingSafeEqual(actual, expected)
    && Number(nStr) === SCRYPT.N && Number(rStr) === SCRYPT.r && Number(pStr) === SCRYPT.p;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// The audit chain: each row's hash covers the previous row's hash, so an inserted
// or edited line is detectable by recomputation rather than by trust in the writer.
export function auditRowHash(input: {
  prevHash: string | null;
  actorUserId: number | null;
  actorKind: string;
  tenantId: number | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail: unknown;
  occurredAt: Date;
}): string {
  const canonical = JSON.stringify([
    input.prevHash ?? 'GENESIS',
    input.actorUserId, input.actorKind, input.tenantId, input.action,
    input.entity, input.entityId, canonicalise(input.detail), input.occurredAt.toISOString(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalise(obj[k])}`).join(',')}}`;
}

export function signUploadWebhook(secret: string, body: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
