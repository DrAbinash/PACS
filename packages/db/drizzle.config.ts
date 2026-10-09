import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.TR_DB_URL ?? 'postgresql://telrad:telrad@127.0.0.1:5433/telrad',
  },
  strict: true,
  verbose: true,
});
