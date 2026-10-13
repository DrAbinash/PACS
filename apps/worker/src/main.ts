import { openDbWithRetry } from '@telrad/db';
import { sql } from 'drizzle-orm';
import { autoEscalateOnce } from './auto-escalate.js';
import { criticalSweepOnce } from './criticals.js';
import { dispatchSweep } from './dispatch.js';
import { escalateOnce } from './escalate.js';
import { notifyOnce } from './notify.js';
import { pollOnce, recheckStalled } from './ingest.js';
import { drainOnce } from './inbox.js';
import { createReleaseStore, releaseSweepOnce } from './release.js';
import { createRetentionStore, retentionSweepOnce } from './retention.js';
import { reviewSweepOnce } from './review.js';
import { createOrthancReader, createOrthancWriter } from './orthanc.js';
import { opsDigestOnce } from './ops.js';
import { createSmtpTransport } from './smtp.js';
import { createWhatsAppTransport } from './whatsapp.js';
import { createCriticalStore, createDispatchStore, createEscalationStore, createInboxStore, createNotifyStore, createOpsStore, createStore } from './store.js';
import { logger, childLogger } from './logger.js';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const nodeId = process.env.TR_NODE_ID ?? 'node-nas-01';
const pollSeconds = Math.max(Number(process.env.TR_WORKER_POLL_SECONDS ?? 10), 2);
const poolMaxRaw = process.env.TR_DB_POOL_MAX;
const poolMax = poolMaxRaw ? Number(poolMaxRaw) : undefined;
if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1)) {
  throw new Error('TR_DB_POOL_MAX must be a positive integer');
}
// Retry with backoff so the worker survives a cold-boot race with the db container.
const handle = await openDbWithRetry(env('TR_DB_URL'), { max: poolMax });

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
const release = createReleaseStore(handle.db);
const ops = createOpsStore(handle.db);
const retention = createRetentionStore(handle.db, orthancWriter);
// Both halves have to be present before anything leaves. A relay without a public origin would
// send a message whose only actionable line — "read it here" — is a relative link, which is a
// letter with no address on it rather than a bug in the mailer.
const smtp = createSmtpTransport({
  url: process.env.TR_SMTP_URL ?? null,
  from: process.env.TR_SMTP_FROM ?? null,
});
const publicUrl = (process.env.TR_PUBLIC_URL ?? '').replace(/\/+$/, '');
// The WhatsApp half of the outbox, dormant until Meta's credentials exist. An empty TR_WHATSAPP_*
// is a documented state, not a misconfiguration: the transport reports unconfigured, whatsapp
// rows queue exactly as email rows do, and they wait until the env carries the token — no code
// changes on the day the API is granted. TR_WHATSAPP_TEMPLATE must name the pre-approved
// template whose placeholders appear in the order reportReadyTemplateParams produces.
const whatsapp = createWhatsAppTransport({
  token: process.env.TR_WHATSAPP_TOKEN ?? null,
  phoneNumberId: process.env.TR_WHATSAPP_PHONE_ID ?? null,
  templateName: process.env.TR_WHATSAPP_TEMPLATE ?? null,
  language: process.env.TR_WHATSAPP_LANGUAGE ?? 'en',
});
// The ops digest rides the same relay as the clinic mail but carries none of its content: it
// reads the sweeps' alert audit rows back to one operator address on a bounded cadence. An
// empty address is a documented state — alerts stay audit-only and the boot line says so.
const opsEmail = process.env.TR_OPS_EMAIL || null;
const opsDigestMinutes = Math.max(Number(process.env.TR_OPS_DIGEST_MINUTES ?? 5), 1);
// The retention sweep runs on its own clock, not the poll cadence: deleting a
// study is heavy work on the node, and a ten-second poll turning into a
// ten-second delete storm would starve ingest. A worker restart resets the
// clock; the sweep is idempotent, so an early re-run only re-checks an empty set.
const retentionSweepMinutes = Math.max(Number(process.env.TR_RETENTION_SWEEP_MINUTES ?? 1440), 1);
let retentionRunAt = 0;

async function notify(): Promise<void> {
  // Either channel alone is enough to run the sweep; the sweep gates each row on its own
  // transport, so a deployment with mail but no Meta account still drains its email queue.
  if (!smtp.configured && !whatsapp.configured) return;
  if (publicUrl === '') {
    console.warn('notify skipped: a transport is configured but TR_PUBLIC_URL is not, so the '
      + 'message would carry no link to the portal');
    return;
  }
  const n = await notifyOnce(notifications, { email: smtp, whatsapp }, { portalUrl: `${publicUrl}/portal` });
  if (n.sent + n.retried + n.dead + n.refused > 0) {
    console.log(`notify checked=${n.checked} sent=${n.sent} retried=${n.retried} dead=${n.dead} `
      + `refused=${n.refused} via=${smtp.configured ? smtp.label : ''}`
      + `${smtp.configured && whatsapp.configured ? '+' : ''}${whatsapp.configured ? whatsapp.label : ''}`);
  }
}

// The digest is read off the same audit log every sweep writes to, so it runs last in a tick —
// after the sweeps have finished writing — and holds itself to a minimum interval, because an
// operator who receives ten mails learns to filter the address and an operator who receives
// none learns nothing. A held or failed digest logs nothing: the cursor has not moved and the
// next tick reads the same rows.
async function opsDigest(): Promise<void> {
  const d = await opsDigestOnce(ops, smtp, { to: opsEmail, now: new Date(), intervalMs: opsDigestMinutes * 60_000 });
  if (d.sent) {
    console.log(`ops digest sent alerts=${d.alerts} cursor=${d.cursor} via=${smtp.label}`);
  } else if (d.alerts > 0) {
    console.log(`ops digest send failed alerts=${d.alerts} (attempt recorded; retry at digest interval)`);
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

// A reader who accepted a case and then walked away leaves a live lock on the study —
// dispatch cannot re-offer it, and the case sits until the reader returns and declines
// by hand. This sweep releases cases held by readers who went offline or stopped
// heartbeating, so the next dispatch tick in the same cycle can re-route them.
async function releaseStale(): Promise<void> {
  const r = await releaseSweepOnce(release);
  if (r.released > 0) {
    const reasons = Object.entries(r.byReason).map(([k, v]) => `${k}:${v}`).join(',');
    console.log(`release checked=${r.checked} released=${r.released} (${reasons})`);
  }
}

// Pixels leave, records stay. The sweep is gated on its own interval; counts print
// only when something happened, because a daily sweep that finds nothing due must
// not look like an event in the log.
async function retentionSweep(): Promise<void> {
  const now = Date.now();
  if (now < retentionRunAt) return;
  retentionRunAt = now + retentionSweepMinutes * 60_000;
  const p = await retentionSweepOnce(retention);
  if (p.checked > 0 || p.failed > 0) {
    console.log(`retention checked=${p.checked} purged=${p.purged} failed=${p.failed} `
      + '(pixels deleted; reports, billing and audit untouched)');
  }
}

async function sweep(): Promise<void> {
  const d = await dispatchSweep(dispatch);
  // Structured logging: the operator's log aggregator can query `offered > 0` or
  // `exhausted > 0` directly, without parsing strings. The unassigned array is logged
  // as a structured field so a dashboard can show which studies are stuck and why.
  if (d.widened > 0) logger.info({ widened: d.widened }, 'dispatch widened');
  if (d.exhausted > 0) logger.info({ exhausted: d.exhausted }, 'dispatch exhausted');
  if (d.expired > 0 || d.offered > 0 || d.unassigned.length > 0) {
    logger.info({
      offered: d.offered,
      expired: d.expired,
      unassigned_count: d.unassigned.length,
      unassigned: d.unassigned.slice(0, 3).map((u) => ({
        studyId: u.studyId,
        reason: u.reason,
        gap: u.gap?.missing.join('+') ?? null,
      })),
    }, 'dispatch tick');
  }
}

async function tick(): Promise<void> {
  if (stopping || ticking) return;
  // A distributed lock so two workers cannot run concurrently. The ingest cursor and the
  // escalation ladder are not idempotent: a second worker would double-advance the cursor
  // and re-fire stages. pg_try_advisory_lock is session-scoped and auto-releases on disconnect,
  // so a dead worker's lock dies with its connection — no stale lock to clean up.
  const lockResult = await handle.db.execute<{ acquired: boolean }>(
    sql`select pg_try_advisory_lock(1) as acquired`
  );
  if (!lockResult[0]?.acquired) {
    // Another worker holds the lock. This tick is skipped; the next interval will retry.
    return;
  }
  ticking = true;
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
      // Structured fields for log aggregation: a dashboard can plot created/orphans/ambiguous
      // over time without parsing strings.
      logger.info({
        node: nodeId,
        seen: r.seen,
        created: r.created,
        updated: r.updated,
        orphans: r.orphans,
        ambiguous: r.ambiguous,
        unresolved_site: r.unresolvedSite,
        incomplete: r.incomplete,
        sla_opened: r.slaOpened,
      }, 'ingest poll');
    }
    const settled = await recheckStalled(orthanc, store, { nodeId });
    if (settled.seen > 0) {
      logger.info({
        node: nodeId,
        rechecked: settled.seen,
        completed: settled.completed,
        clocks_opened: settled.clocks,
      }, 'ingest settle');
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
    await autoEscalateOnce({ db: handle.db, nodeId });
  } catch (err) {
    console.error('auto-escalate failed', err instanceof Error ? err.message : err);
  }

  try {
    await releaseStale();
  } catch (err) {
    console.error('release sweep failed', err instanceof Error ? err.message : err);
  }

  try {
    await retentionSweep();
  } catch (err) {
    console.error('retention sweep failed', err instanceof Error ? err.message : err);
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
    // Release the advisory lock so the next tick (this worker or another) can acquire it.
    // pg_advisory_unlock returns false if the lock was not held, which should never happen
    // here — but if it does, the next tick will simply acquire it fresh.
    await handle.db.execute(sql`select pg_advisory_unlock(1)`);
    ticking = false;
  }

  try {
    await opsDigest();
  } catch (err) {
    console.error('ops digest failed', err instanceof Error ? err.message : err);
  }
}

// Structured startup log: the operator's log aggregator can query `node=node-nas-01`
// to find all logs from this worker instance, and `mode=loop` vs `mode=once` distinguishes
// long-running workers from verification runs.
logger.info({
  node: nodeId,
  poll_seconds: pollSeconds,
  mode: process.argv[2] ?? 'loop',
  mail: smtp.configured ? smtp.label : 'not_configured',
  ops: opsEmail ? `digest_to_${opsEmail}_every_${opsDigestMinutes}m` : 'not_configured',
  retention_minutes: retentionSweepMinutes,
  whatsapp: whatsapp.configured ? whatsapp.label : 'not_configured',
}, 'telrad worker starting');

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
} else if (process.argv[2] === 'ops-once') {
  // Only the digest. A verification run uses this to see exactly what would be mailed; with
  // a relay configured it sends real mail, and the interval and cursor still apply, so a
  // repeat run within the interval holds rather than double-sending.
  await opsDigest();
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
} else if (process.argv[2] === 'release-once') {
  // Only the release sweep. A verification run uses this to prove that a reader who went
  // offline has their cases returned without touching routing or dispatch.
  await releaseStale();
  await handle.close();
} else if (process.argv[2] === 'retention-once') {
  // Only the retention sweep, ignoring the interval. A verification run uses this to
  // prove pixels leave and records stay, without routing, dispatch or ingest beside it.
  const p = await retentionSweepOnce(retention);
  console.log(`retention checked=${p.checked} purged=${p.purged} failed=${p.failed}`);
  await handle.close();
} else if (process.argv[2] === 'auto-escalate-once') {
  // Only the auto-escalation sweep. A verification run uses this to bump priorities
  // without touching routing or dispatch.
  await autoEscalateOnce({ db: handle.db, nodeId });
  await handle.close();
} else if (process.argv[2] === 'once') {
  await tick();
  await handle.close();
} else {
  await tick();
  let tickPromise: Promise<void> | null = null;
  const timer = setInterval(() => {
    tickPromise = tick().finally(() => { tickPromise = null; });
  }, pollSeconds * 1000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      console.log(`telrad worker ${signal}: draining`);
      // The in-flight tick holds the pool's connections: closing the pool under
      // it aborts a sweep half-done and leaves the queues it was stamping in a
      // half-stamped state. Wait for the tick, then close; the unref'd timer
      // below is the bound on a tick that never comes back.
      const done = () => { void handle.close().finally(() => process.exit(0)); };
      void (tickPromise ?? Promise.resolve()).then(done, done);
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}
