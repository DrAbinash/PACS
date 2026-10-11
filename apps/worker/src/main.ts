import { openDb } from '@telrad/db';
import { criticalSweepOnce } from './criticals.js';
import { dispatchSweep } from './dispatch.js';
import { escalateOnce } from './escalate.js';
import { notifyOnce } from './notify.js';
import { pollOnce, recheckStalled } from './ingest.js';
import { drainOnce } from './inbox.js';
import { reviewSweepOnce } from './review.js';
import { createOrthancReader, createOrthancWriter } from './orthanc.js';
import { createSmtpTransport } from './smtp.js';
import { createCriticalStore, createDispatchStore, createEscalationStore, createInboxStore, createNotifyStore, createStore } from './store.js';

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
const escalation = createEscalationStore(handle.db);
const criticals = createCriticalStore(handle.db);
const notifications = createNotifyStore(handle.db);
// Both halves have to be present before anything leaves. A relay without a public origin would
// send a message whose only actionable line — "read it here" — is a relative link, which is a
// letter with no address on it rather than a bug in the mailer.
const smtp = createSmtpTransport({
  url: process.env.TR_SMTP_URL ?? null,
  from: process.env.TR_SMTP_FROM ?? null,
});
const publicUrl = (process.env.TR_PUBLIC_URL ?? '').replace(/\/+$/, '');

async function notify(): Promise<void> {
  if (!smtp.configured) return;
  if (publicUrl === '') {
    console.warn('notify skipped: TR_SMTP_URL is set but TR_PUBLIC_URL is not, so the message '
      + 'would carry no link to the portal');
    return;
  }
  const n = await notifyOnce(notifications, smtp, { portalUrl: `${publicUrl}/portal` });
  if (n.sent + n.retried + n.dead + n.refused > 0) {
    console.log(`notify checked=${n.checked} sent=${n.sent} retried=${n.retried} dead=${n.dead} `
      + `refused=${n.refused} via=${smtp.label}`);
  }
}
const inboxRoot = env('TR_INBOX_ROOT');
const removeAfterPush = process.env.TR_INBOX_REMOVE_AFTER_PUSH !== 'false';

let stopping = false;
let ticking = false;

async function escalate(): Promise<void> {
  const e = await escalateOnce(escalation);
  if (e.staged > 0 || e.breached > 0) {
    console.log(`escalate checked=${e.checked} staged=${e.staged} breached=${e.breached} `
      + `actions=${Object.entries(e.byAction).map(([a, n]) => `${a}:${n}`).join(',') || 'none'}`);
  }
}

// A critical loop is settled on its own clock and its own label. The report SLA sweeping a
// deadline is a service measuring its own turnaround; this one is a named clinician still not
// having heard a result, and a tick that fails here is a different outage from a tick that
// fails in routing.
async function settleCriticalLoops(): Promise<void> {
  const c = await criticalSweepOnce(criticals);
  if (c.breached > 0) {
    console.log(`critical checked=${c.checked} breached=${c.breached} waiting=${c.waiting} `
      + '(a finding nobody at the referring end has acknowledged past its deadline)');
  }
}

// A signed report waiting for a second name is not a contract breach — the center was
// answered on time — but a report that has sat unreviewed for two hours is an operational
// gap the review queue does not surface to the operator. This sweep writes an audit row
// so the late board shows it.
async function settleReviewQueue(): Promise<void> {
  const r = await reviewSweepOnce(handle.db);
  if (r.alerted > 0) {
    console.log(`review checked=${r.checked} alerted=${r.alerted} `
      + '(signed reports waiting for a second name past the threshold)');
  }
}

async function sweep(): Promise<void> {
  const d = await dispatchSweep(dispatch);
  if (d.widened > 0) console.log(`dispatch widened=${d.widened} (offers to at-capacity readers under a live widen_pool stage)`);
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
    await settleCriticalLoops();
  } catch (err) {
    // Its own label, for its own reason: a loop that never gets its breach stamped is a
    // quality failure the operator cannot see, and a log line that says `dispatch failed`
    // would send them looking at routing.
    console.error('critical sweep failed', err instanceof Error ? err.message : err);
  }

  try {
    await settleReviewQueue();
  } catch (err) {
    console.error('review sweep failed', err instanceof Error ? err.message : err);
  }

  try {
    // Its own label again: a clinic that was never told about a report is a different outage
    // from a case that was never routed, and the two queues do not share a failure mode.
    await notify();
  } catch (err) {
    console.error('notify failed', err instanceof Error ? err.message : err);
  }

  try {
    // Escalate before dispatch so a case that has just crossed its widen threshold can be
    // offered to a fuller reader on this tick rather than the next one; dispatch runs
    // last so a study that just became complete and linked is offered in the same tick it
    // appeared.
    await escalate();
    await sweep();
  } catch (err) {
    console.error('dispatch failed', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

console.log(`telrad worker starting node=${nodeId} poll=${pollSeconds}s mode=${process.argv[2] ?? 'loop'} `
  + `mail=${smtp.configured ? `smtp via ${smtp.label}` : 'not configured (queued notifications will wait)'}`);

if (process.argv[2] === 'dispatch-once') {
  // The routing half of a tick with no ingest beside it: the critical clocks, then
  // escalation, then dispatch.
  // Exists for a first deploy, where the queue is seeded by hand and an operator wants
  // to see the routing decision before any pixels arrive, and for verification.
  await settleCriticalLoops();
  await escalate();
  await sweep();
  await handle.close();
} else if (process.argv[2] === 'notify-once') {
  // The outbox on its own. A verification run that proves a clinic was told must not also
  // dispatch, because then the state it ends by asserting is one it caused.
  await notify();
  await handle.close();
} else if (process.argv[2] === 'criticals-once') {
  // Only the acknowledgement clocks. A verification run uses this to stamp a breach without
  // touching routing, because a sweep that also dispatches moves cases onto readers' desks
  // and the run then proves nothing about the loop it came to look at.
  await settleCriticalLoops();
  await handle.close();
} else if (process.argv[2] === 'review-once') {
  // Only the review queue sweep. A verification run uses this to alert on reports waiting
  // for a second name without touching routing or critical loops.
  await settleReviewQueue();
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
