import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export { schema };
export * from './schema.js';
export * from './dispatch-reads.js';

export const SCHEMA = 'telrad';

export type Db = PostgresJsDatabase<typeof schema>;

export type DbHandle = {
  db: Db;
  close: () => Promise<void>;
};

export function openDb(url: string, opts?: { max?: number }): DbHandle {
  const client = postgres(url, {
    max: opts?.max ?? 5,
    prepare: false,
    transform: { undefined: null },
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

// Tables are declared inside `schema telrad`, so drizzle qualifies every
// reference and a shared Postgres instance cannot be confused with another
// product's tables. This check is the readiness probe's real question: has a
// migration been applied here at all.
export async function assertMigrated(db: Db): Promise<void> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from information_schema.tables
        where table_schema = ${SCHEMA} and table_name = 'studies'`,
  );
  if (rows[0]?.n !== '1') {
    throw new Error(`schema "${SCHEMA}" is not migrated; run pnpm --filter @telrad/db db:migrate`);
  }
}
