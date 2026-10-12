import { runMigrations } from './migrate-runner.js';

const url = process.env.TR_DB_URL;
if (!url) throw new Error('TR_DB_URL is required');

await runMigrations(url);
