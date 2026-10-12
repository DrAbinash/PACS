import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { SCHEMA, assertMigrated, schema } from './index.js';

// Owns a single-connection client rather than openDb's pool: drizzle's migrator
// conflicts with prepared statements, and the migration must not share the app's
// connections. Exported so both the host script and the api container's
// `cli.js migrate` run the identical code — a deployment step that exists in two
// variants is two steps, and only one of them gets tested.
export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  try {
    // The generated migration owns `create schema`. Pre-creating it here made the
    // first deploy fail with "schema already exists", which is the kind of ordering
    // bug that only appears on a virgin database.
    await migrate(db, { migrationsFolder: process.env.TR_MIGRATIONS_DIR ?? './migrations' });

    // Two assertions rather than one. The second catches the failure mode the first
    // cannot: a migration emitted without a schema qualifier, which would put a
    // patient table in `public` while still leaving telrad looking healthy. Only our
    // own names are checked, because extensions legitimately live in public.
    await assertMigrated(db);
    const leaked = await db.execute<{ name: string }>(
      sql`select table_name as name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('studies','patients','tenants','orders','reports','assignments','audit_log')`,
    );
    if (leaked.length > 0) {
      throw new Error(
        `telrad table(s) found in public: ${leaked.map((r) => r.name).join(', ')} — refusing a mixed-schema database`,
      );
    }
    console.log(`migrated schema "${SCHEMA}"`);
  } finally {
    await client.end({ timeout: 5 });
  }
}
