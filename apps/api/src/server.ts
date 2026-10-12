import {
  assertMigrated,
  openDb,
} from '@telrad/db';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createOrthancClient } from './orthanc.js';

const env = loadEnv();
const version = process.env.TR_RELEASE ?? 'dev';
const handle = openDb(env.dbUrl, { max: env.dbPoolMax });

// Fail fast, before the port is bound. A service that answers /health/live while
// its own schema is missing is worse than one that refuses to start.
await assertMigrated(handle.db);

const orthanc = createOrthancClient(env.orthanc);
const app = createApp({ db: handle.db, version, inboxRoot: env.inboxRoot, secureCookies: env.publicUrl.startsWith('https'), orthanc });

const server = app.listen(env.port, env.bindHost, () => {
  console.log(`telrad api starting version=${version} port=${env.port}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`telrad api ${signal}: draining`);
    server.close(() => { void handle.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
