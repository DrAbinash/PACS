import { describe, expect, it } from 'vitest';
import { MAX_NOTIFY_ATTEMPTS } from '@telrad/shared';
import { emptyNotifyResult, notifyOnce, type NotifyPort, type NotifyTransport, type QueuedNotification } from '../src/notify.js';
import type { WhatsAppTransport } from '../src/whatsapp.js';

const NOW = new Date('2026-10-10T04:00:00Z');

const queued = (over: Partial<QueuedNotification> = {}): QueuedNotification => ({
  id: 7,
  reportId: 3,
  tenantId: 1,
  recipient: 'dr.rao@govhosp.in',
  channel: 'email',
  status: 'pending',
  attemptNo: 0,
  nextAttemptAt: NOW,
  accession: 'ACC-REP-1',
  version: 2,
  signedAt: new Date('2026-10-10T03:10:00Z'),
  centreName: 'Sparsh Diagnostic Centre',
  tenantCode: 'whq',
  hasSecondSignature: true,
  patientName: 'Kavita Rao',
  patientMrn: 'P-REP-1',
  ...over,
});

type Sent = { to: string; subject: string; text: string };

function fakePort(rows: QueuedNotification[]) {
  const recorded: { id: number; status: string; attemptNo: number; next: Date | null; sentAt: Date | null }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const port: NotifyPort = {
    async due() { return rows; },
    async record(id, outcome, sentAt) {
      recorded.push({
        id, status: outcome.status, attemptNo: outcome.attemptNo,
        next: outcome.nextAttemptAt, sentAt,
      });
    },
    async audit(input) {
      audits.push({ action: input.action, detail: (input.detail ?? {}) as Record<string, unknown> });
    },
  };
  return { port, recorded, audits };
}

function transport(result: { ok: boolean; error?: string }): NotifyTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    configured: true,
    label: 'smtp:test',
    sent,
    async send(message) {
      sent.push(message);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'ECONNREFUSED' };
    },
  };
}

function waTransport(result: { ok: boolean; error?: string }): WhatsAppTransport & { sent: { to: string; params: string[] }[] } {
  const sent: { to: string; params: string[] }[] = [];
  return {
    configured: true,
    label: 'wa:test',
    sent,
    async send(message) {
      sent.push(message);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'no_message_id' };
    },
  };
}

const offEmail = (): NotifyTransport => ({
  configured: false, label: 'not configured', send: async () => ({ ok: false, error: 'smtp_not_configured' }),
});

const offWa = (): WhatsAppTransport => ({
  configured: false, label: 'not configured', send: async () => ({ ok: false, error: 'whatsapp_not_configured' }),
});

// The shim that keeps the email-path tests reading as they did: whatsapp dormant, so the only
// live wire is the one the test built.
const run = (
  port: NotifyPort,
  email: NotifyTransport,
  opts: { now?: () => Date; limit?: number; portalUrl?: string } = {},
) => notifyOnce(port, { email, whatsapp: offWa() }, opts);

describe('notifyOnce', () => {
  it('does nothing at all when the deployment has no relay', async () => {
    // Not `dead`, not `failed`, not a single write: a box with no SMTP configured must not
    // destroy the record of which clinics were never told.
    const { port, recorded, audits } = fakePort([queued()]);
    const off: NotifyTransport = {
      configured: false, label: 'not configured', send: async () => ({ ok: false, error: 'smtp_not_configured' }),
    };
    const r = await run(port, off, { now: () => NOW });
    expect(r).toEqual({ ...emptyNotifyResult(true), skipped: true });
    expect(recorded).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('sends the message and records the row as sent', async () => {
    const t = transport({ ok: true });
    const { port, recorded, audits } = fakePort([queued()]);
    const r = await run(port, t, { now: () => NOW, portalUrl: 'https://telrad.example/portal' });
    expect(r).toMatchObject({ checked: 1, sent: 1, retried: 0, dead: 0 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('dr.rao@govhosp.in');
    expect(t.sent[0]!.subject).toBe('Report ready — ACC-REP-1 (version 2)');
    expect(t.sent[0]!.text).toContain('https://telrad.example/portal');
    expect(recorded[0]).toMatchObject({ id: 7, status: 'sent', attemptNo: 1 });
    expect(recorded[0]!.sentAt).toEqual(NOW);
    expect(audits[0]!.action).toBe('notify.sent');
  });

  it('puts no patient identifier on the wire', async () => {
    const t = transport({ ok: true });
    const { port } = fakePort([queued()]);
    await run(port, t, { now: () => NOW });
    const body = `${t.sent[0]!.subject}\n${t.sent[0]!.text}`;
    expect(body).not.toContain('Kavita Rao');
    expect(body).not.toContain('P-REP-1');
    expect(body.toLowerCase()).not.toContain('findings');
  });

  it('counts the signatures on the document, not the ones the rule demanded', async () => {
    // A tenant that switches `requires_reviewer` off to release a case leaves that case with one
    // name under it. The email is the clinic's only sight of the document before it opens the
    // portal, so the sentence has to come from the row, and a second name that is not there must
    // not be reported as there.
    const withOne = transport({ ok: true });
    await run(fakePort([queued({ hasSecondSignature: false })]).port, withOne, { now: () => NOW });
    expect(withOne.sent[0]!.text).toContain('carries one signature');

    const withTwo = transport({ ok: true });
    await run(fakePort([queued({ hasSecondSignature: true })]).port, withTwo, { now: () => NOW });
    expect(withTwo.sent[0]!.text).toContain('carries two signatures');
  });

  it('refuses and kills a message that does carry one, without trying it again', async () => {
    // The scenario is real: a centre whose *legal name* is the patient's name, or a template
    // change that adds the MRN. Retrying would send the same leak five times, so this is the
    // one failure that is terminal on sight.
    const t = transport({ ok: true });
    const { port, recorded, audits } = fakePort([queued({ centreName: 'Kavita Rao' })]);
    const r = await run(port, t, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, refused: 1, sent: 0 });
    expect(t.sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ status: 'dead', next: null });
    expect(audits[0]!.action).toBe('notify.refused');
    expect(audits[0]!.detail.reason).toBe('patient_identifier_in_body');
    // The audit row must not echo what the message refused to carry.
    expect(JSON.stringify(audits[0]!.detail)).not.toContain('Kavita Rao');
  });

  it('schedules a retry on the backoff ladder rather than trying again immediately', async () => {
    const t = transport({ ok: false, error: 'EAUTH bad credentials' });
    const { port, recorded, audits } = fakePort([queued({ attemptNo: 2, status: 'failed' })]);
    const r = await run(port, t, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, retried: 1, dead: 0 });
    // Attempt 3 just failed, so the wait is the third rung.
    expect(recorded[0]).toMatchObject({
      status: 'failed', attemptNo: 3, sentAt: null,
      next: new Date(NOW.getTime() + 30 * 60_000),
    });
    expect(audits[0]!.action).toBe('notify.failed');
    expect(audits[0]!.detail.errorCode).toBe('EAUTH bad credentials');
  });

  it('goes dead on the last attempt and says so in its own audit action', async () => {
    const t = transport({ ok: false, error: 'ECONNREFUSED' });
    const { port, recorded, audits } = fakePort([queued({ attemptNo: MAX_NOTIFY_ATTEMPTS - 1 })]);
    const r = await run(port, t, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, retried: 0, dead: 1 });
    expect(recorded[0]).toMatchObject({
      status: 'dead', attemptNo: MAX_NOTIFY_ATTEMPTS, next: null,
    });
    expect(audits[0]!.action).toBe('notify.dead');
  });

  it('leaves a row alone when the port hands it something that is not due', async () => {
    // The query filters this too. Both halves have to agree, because a queue that fetches what
    // it will not send grows with every failed message in history.
    const t = transport({ ok: true });
    const { port, recorded } = fakePort([queued({ nextAttemptAt: new Date(NOW.getTime() + 60_000) })]);
    const r = await run(port, t, { now: () => NOW });
    expect(r).toMatchObject({ checked: 0, sent: 0 });
    expect(recorded).toEqual([]);
  });

  it('counts a whole queue, keeps going after one row fails, and will not re-send a sent one', async () => {
    const t = transport({ ok: false, error: 'mailbox full' });
    const { port, recorded, audits } = fakePort([
      queued({ id: 1 }), queued({ id: 2 }), queued({ id: 3, status: 'sent' }),
    ]);
    const r = await run(port, t, { now: () => NOW });
    // Three rows handed over, two attempted. The store's query excludes terminal rows and this
    // guard refuses them anyway, because a duplicate "report ready" email to a clinic is a bug
    // nobody sees until the clinic mentions it three weeks later.
    expect(r).toMatchObject({ checked: 2, retried: 2 });
    expect(recorded.map((x) => x.id)).toEqual([1, 2]);
    expect(audits).toHaveLength(2);
  });

  it('routes a whatsapp row down the whatsapp transport with the template parameters', async () => {
    const email = transport({ ok: true });
    const wa = waTransport({ ok: true });
    const { port, recorded, audits } = fakePort([
      queued({ channel: 'whatsapp', recipient: '+919845012345' }),
    ]);
    const r = await notifyOnce(port, { email, whatsapp: wa }, {
      now: () => NOW, portalUrl: 'https://telrad.example/portal',
    });
    expect(r).toMatchObject({ checked: 1, sent: 1 });
    expect(email.sent).toEqual([]);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe('+919845012345');
    // Positional, and in the order the approved Meta template's placeholders must appear.
    expect(wa.sent[0]!.params).toEqual([
      'Sparsh Diagnostic Centre', 'ACC-REP-1', '2', 'https://telrad.example/portal',
    ]);
    expect(recorded[0]).toMatchObject({ id: 7, status: 'sent', attemptNo: 1, sentAt: NOW });
    expect(audits[0]!.action).toBe('notify.sent');
    expect(audits[0]!.detail.channel).toBe('whatsapp');
  });

  it('leaves whatsapp rows waiting on unwired Meta credentials and drains email anyway', async () => {
    // A deployment with a relay but no Meta account is a supported state, not an error half the
    // system should stop for: the email rows move, the whatsapp rows say on the board that they
    // are waiting, and nothing goes dead for lack of a wire it never asked for.
    const email = transport({ ok: true });
    const { port, recorded, audits } = fakePort([
      queued({ id: 1, channel: 'whatsapp', recipient: '+919845012345' }),
      queued({ id: 2 }),
    ]);
    const r = await notifyOnce(port, { email, whatsapp: offWa() }, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, sent: 1, dead: 0 });
    expect(recorded.map((x) => x.id)).toEqual([2]);
    expect(audits).toHaveLength(1);
  });

  it('refuses a whatsapp message that would carry an identifier in its parameters', async () => {
    // Same refusal the email path has, same terminal state: a template parameter is text on the
    // wire, and a centre whose legal name is the patient's name reaches it by the same road.
    const wa = waTransport({ ok: true });
    const { port, recorded, audits } = fakePort([
      queued({ channel: 'whatsapp', recipient: '+919845012345', centreName: 'Kavita Rao' }),
    ]);
    const r = await notifyOnce(port, { email: offEmail(), whatsapp: wa }, { now: () => NOW });
    expect(r).toMatchObject({ checked: 1, refused: 1, sent: 0 });
    expect(wa.sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ status: 'dead', next: null });
    expect(audits[0]!.action).toBe('notify.refused');
    expect(audits[0]!.detail.channel).toBe('whatsapp');
    expect(JSON.stringify(audits[0]!.detail)).not.toContain('Kavita Rao');
  });
});
