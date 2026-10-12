import { describe, expect, it } from 'vitest';
import type { OpsDigestRow } from '@telrad/shared';
import { opsDigestOnce, type OpsDigestState, type OpsPort } from '../src/ops.js';
import type { NotifyTransport, SendResult } from '../src/notify.js';

const NOW = new Date('2026-10-12T10:00:00Z');

const alertRow = (id: number, detail: Record<string, unknown> | null = null): OpsDigestRow => ({
  id,
  occurredAt: new Date(NOW.getTime() - 60_000),
  action: 'critical.breached',
  entity: 'critical_events',
  entityId: String(id),
  detail,
});

type FakeTransport = NotifyTransport & { sends: { to: string; subject: string; text: string }[] };

const fakeTransport = (ok: boolean, configured = true): FakeTransport => {
  const transport: FakeTransport = {
    configured,
    label: 'test-relay',
    sends: [],
    async send(message) {
      transport.sends.push(message);
      const result: SendResult = ok ? { ok: true } : { ok: false, error: 'relay_down' };
      return result;
    },
  };
  return transport;
};

// The fake mirrors the store's contract: a successful record moves the cursor, a failed one
// only stamps the attempt time. opsDigestOnce must work against that contract, not against
// this fake's internals.
const fakePort = (rows: OpsDigestRow[], state: Partial<OpsDigestState> = {}) => {
  const st: OpsDigestState = { cursor: 0, cursorAt: null, lastAttemptAt: null, ...state };
  const calls = {
    sinces: [] as number[],
    records: [] as { ok: boolean; lastAuditId: number | null; alerts: number }[],
  };
  const port: OpsPort = {
    async alertsSince(since, limit) {
      calls.sinces.push(since);
      return rows.filter((r) => r.id > since).slice(0, limit);
    },
    async digestState() { return { ...st }; },
    async recordDigest(record) {
      calls.records.push(record);
      if (record.ok && record.lastAuditId !== null) {
        st.cursor = record.lastAuditId;
        st.cursorAt = NOW;
      }
      st.lastAttemptAt = NOW;
    },
  };
  return { port, calls, st };
};

describe('opsDigestOnce', () => {
  it('does nothing when the deployment has no relay', async () => {
    const { port, calls } = fakePort([alertRow(1)]);
    const t = fakeTransport(true, false);
    const out = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(out).toEqual({ alerts: 0, sent: false, held: false, cursor: 0 });
    expect(calls.sinces).toEqual([]);
    expect(t.sends).toEqual([]);
  });

  it('does nothing when no address is configured', async () => {
    const { port, calls } = fakePort([alertRow(1)]);
    const t = fakeTransport(true);
    const out = await opsDigestOnce(port, t, { to: null, now: NOW });
    expect(out.sent).toBe(false);
    expect(calls.sinces).toEqual([]);
    expect(t.sends).toEqual([]);
  });

  it('sends nothing and records nothing when no alerts are waiting', async () => {
    const { port, calls } = fakePort([]);
    const t = fakeTransport(true);
    const out = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(out).toEqual({ alerts: 0, sent: false, held: false, cursor: 0 });
    expect(t.sends).toEqual([]);
    expect(calls.records).toEqual([]);
  });

  it('sends the waiting alerts and advances the cursor to the last row id', async () => {
    const rows = [alertRow(3), alertRow(5, { errorCode: 'smtp_relay_refused' })];
    const { port, calls } = fakePort(rows, { lastAttemptAt: new Date(NOW.getTime() - 10 * 60_000) });
    const t = fakeTransport(true);
    const out = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(out).toEqual({ alerts: 2, sent: true, held: false, cursor: 5 });
    expect(calls.sinces).toEqual([0]);
    expect(calls.records).toEqual([{ ok: true, lastAuditId: 5, alerts: 2 }]);
    expect(t.sends).toHaveLength(1);
    const mail = t.sends[0];
    if (!mail) throw new Error('expected one send');
    expect(mail.to).toBe('ops@clinic.test');
    expect(mail.subject).toBe('[telrad] 2 ops alerts since startup');
    expect(mail.text).toContain('critical.breached');
  });

  it('names the last successful digest in the subject when one exists', async () => {
    const { port } = fakePort([alertRow(9)], {
      cursor: 4,
      cursorAt: new Date('2026-10-12T09:30:00Z'),
      lastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const t = fakeTransport(true);
    await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(t.sends[0]?.subject).toBe('[telrad] 1 ops alert since 2026-10-12T09:30:00.000Z');
  });

  it('holds inside the interval even when alerts are waiting', async () => {
    const { port, calls } = fakePort([alertRow(1)], { lastAttemptAt: new Date(NOW.getTime() - 60_000) });
    const t = fakeTransport(true);
    const out = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(out).toEqual({ alerts: 0, sent: false, held: true, cursor: 0 });
    expect(calls.sinces).toEqual([]);
    expect(t.sends).toEqual([]);
  });

  it('records a failed send but keeps the cursor, so the same alerts go out next interval', async () => {
    const { port, calls } = fakePort([alertRow(3)], { lastAttemptAt: new Date(NOW.getTime() - 10 * 60_000) });
    const t = fakeTransport(false);
    const first = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(first).toEqual({ alerts: 1, sent: false, held: false, cursor: 0 });
    expect(calls.records).toEqual([{ ok: false, lastAuditId: null, alerts: 1 }]);
    // A minute later the failed attempt still paces the retry.
    const held = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: new Date(NOW.getTime() + 60_000) });
    expect(held.held).toBe(true);
    // Past the interval the same alerts are read again from the same cursor.
    const retry = await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: new Date(NOW.getTime() + 6 * 60_000) });
    expect(calls.sinces).toEqual([0, 0]);
    expect(retry.alerts).toBe(1);
  });

  it('cannot mail a patient name that a sweep wrote into detail', async () => {
    const { port } = fakePort(
      [alertRow(2, { patientName: 'Ravi Rao', studyId: 42 })],
      { lastAttemptAt: new Date(NOW.getTime() - 10 * 60_000) },
    );
    const t = fakeTransport(true);
    await opsDigestOnce(port, t, { to: 'ops@clinic.test', now: NOW });
    expect(t.sends[0]?.text).toContain('studyId=42');
    expect(t.sends[0]?.text).not.toContain('Ravi');
  });
});
