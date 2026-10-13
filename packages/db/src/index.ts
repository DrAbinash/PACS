import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export { schema };
export * from './schema.js';
export * from './dispatch-reads.js';
export * from './audit.js';
export { runMigrations } from './migrate-runner.js';

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

// Cold-boot race: the api container may start before the db container is accepting
// connections. Without retry, the process dies and the orchestrator restarts it, but
// a 2s backoff with 5 attempts covers the typical 10s Postgres startup window.
export async function openDbWithRetry(url: string, opts?: { max?: number; retries?: number }): Promise<DbHandle> {
  const retries = opts?.retries ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const handle = openDb(url, opts);
      // Test the connection with a trivial query. If this throws, the DB is not ready.
      await handle.db.execute(sql`select 1`);
      return handle;
    } catch (err) {
      lastErr = err;
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s. Total wait ~62s, well within the
      // typical container restart timeout.
      const delay = Math.min(2000 * Math.pow(2, attempt), 32000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`failed to connect to database after ${retries} attempts`, { cause: lastErr });
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
