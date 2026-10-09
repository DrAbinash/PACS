import { openDb } from '@telrad/db';
import { dispatchSweep } from './dispatch.js';
import { pollOnce, recheckStalled } from './ingest.js';
import { drainOnce } from './inbox.js';
import { createOrthancReader, createOrthancWriter } from './orthanc.js';
import { createDispatchStore, createInboxStore, createStore } from './store.js';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const nodeId = process.env.TR_NODE_ID ?? 'node-nas-01';
const pollSeconds = Math.max(Number(process.env.TR_WORKER_POLL_SECONDS ?? 10), 2);
const handle = openDb(env('TR_DB_URL'));

const orthanc = createOrthancReader({
  baseUrl: env('TR_ORTHANC_URL'),
  user: env('TR_ORTHANC_USER'),
  password: env('TR_ORTHANC_PASSWORD'),
});
const store = createStore(handle.db, nodeId);
const orthancWriter = createOrthancWriter({
  baseUrl: env('TR_ORTHANC_URL'),
  user: env('TR_ORTHANC_USER'),
  password: env('TR_ORTHANC_PASSWORD'),
});
const inbox = createInboxStore(handle.db);
const dispatch = createDispatchStore(handle.db);
const inboxRoot = env('TR_INBOX_ROOT');
const removeAfterPush = process.env.TR_INBOX_REMOVE_AFTER_PUSH !== 'false';

let stopping = false;
let ticking = false;

async function sweep(): Promise<void> {
  const d = await dispatchSweep(dispatch);
  if (d.expired > 0 || d.offered > 0 || d.unassigned.length > 0) {
    console.log(`dispatch offered=${d.offered} expired=${d.expired} unassigned=${d.unassigned.length}`
      + (d.unassigned.length > 0
        // The gap is printed, not swallowed: an operator reading a log at 2 a.m.
        // needs "who was missed and why", which is the same content the console shows.
        ? ` nearest=[${d.unassigned.slice(0, 3).map((u) => `${u.studyId}:${u.reason}${u.gap ? `/${u.gap.missing.join('+')}` : ''}`).join(' ')}]`
        : ''));
  }
}

async function tick(): Promise<void> {
  if (stopping || ticking) return;
  ticking = true;
  // Two stages, two labels. A sweep that fails is a routing outage, not an ingest
  // outage, and a single catch-all log line that says `ingest failed` for both is how
  // an operator ends up debugging the wrong subsystem at 2 a.m.
  try {
    // Drain first: a file uploaded a second ago should not wait on the poll that
    // has to see it for the study to appear.
    for (;;) {
      const drained = await drainOnce(orthancWriter, inbox, { nodeId, inboxRoot, removeAfterPush });
      if (!drained) break;
      console.log(`inbox batch=${drained.batchId} pushed=${drained.pushed} rejected=${drained.rejected}`
        + (drained.error ? ` error=${drained.error.slice(0, 160)}` : ''));
    }
    const r = await pollOnce(orthanc, store, { nodeId });
    if (r.seen > 0) {
      console.log(`ingest node=${nodeId} seen=${r.seen} created=${r.created} updated=${r.updated} `
        + `orphans=${r.orphans} ambiguous=${r.ambiguous} unresolved_site=${r.unresolvedSite} `
        + `incomplete=${r.incomplete} sla_opened=${r.slaOpened}`);
    }
    const settled = await recheckStalled(orthanc, store, { nodeId });
    if (settled.seen > 0) {
      console.log(`settle node=${nodeId} rechecked=${settled.seen} completed=${settled.completed} `
        + `clocks_opened=${settled.clocks}`);
    }
  } catch (err) {
    // The cursor row carries the failure text so the console can show a center that
    // has silently stopped delivering — the only signal an operator has at 2 a.m.
    console.error(`ingest failed node=${nodeId}`, err instanceof Error ? err.message : err);
  }

  try {
    // Dispatch runs last so a study that just became complete and linked is offered
    // in the same tick it appeared, rather than on the following one.
    await sweep();
  } catch (err) {
    console.error('dispatch failed', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

console.log(`telrad worker starting node=${nodeId} poll=${pollSeconds}s mode=${process.argv[2] ?? 'loop'}`);

if (process.argv[2] === 'dispatch-once') {
  // A sweep with no ingest beside it. Exists for a first deploy, where the queue is
  // seeded by hand and an operator wants to see the routing decision before any
  // pixels arrive, and for this repository's own verification.
  await sweep();
  await handle.close();
} else if (process.argv[2] === 'once') {
  await tick();
  await handle.close();
} else {
  await tick();
  const timer = setInterval(() => { void tick(); }, pollSeconds * 1000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      console.log(`telrad worker ${signal}: closing`);
      void handle.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}
