import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { idempotencyKeys } from '@telrad/db';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function checkIdempotency(
  db: Db,
  key: string | null,
  route: string,
  entityId: number,
): Promise<{ status: number; body: unknown } | null> {
  if (!key) return null;
  const [row] = await db.select({
    responseStatus: idempotencyKeys.responseStatus,
    responseBody: idempotencyKeys.responseBody,
  })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.route, route)))
    .limit(1);
  return row ? { status: row.responseStatus, body: row.responseBody } : null;
}

export async function storeIdempotency(
  db: Db,
  key: string | null,
  route: string,
  entityId: number,
  status: number,
  body: unknown,
): Promise<void> {
  if (!key) return;
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  await db.insert(idempotencyKeys)
    .values({
      key,
      route,
      entityId,
      responseStatus: status,
      responseBody: body as Record<string, unknown>,
      expiresAt,
    })
    .onConflictDoNothing();
}

export async function purgeExpiredIdempotencyKeys(db: Db): Promise<number> {
  const result = await db.delete(idempotencyKeys)
    .where(sql`${idempotencyKeys.expiresAt} < now()`)
    .returning({ key: idempotencyKeys.key });
  return result.length;
}
