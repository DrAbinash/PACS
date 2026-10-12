import { describe, expect, it } from 'vitest';
import { DETAIL_KEYS, opsDigestBody, opsDigestLine, opsDigestSubject, type OpsDigestRow } from '../src/ops.js';

const row = (over: Partial<OpsDigestRow> = {}): OpsDigestRow => ({
  id: 7,
  occurredAt: new Date('2026-10-12T09:14:00Z'),
  action: 'critical.breached',
  entity: 'critical_events',
  entityId: '3',
  detail: { studyId: 42, accession: 'ACC-9', conditionCode: 'SDH', waitingMinutes: 95 },
  ...over,
});

describe('opsDigestLine', () => {
  it('prints the row identity and the whitelisted detail keys in list order', () => {
    expect(opsDigestLine(row())).toBe('2026-10-12T09:14:00.000Z critical.breached critical_events#3 '
      + 'studyId=42 accession=ACC-9 conditionCode=SDH waitingMinutes=95');
  });

  it('prints only whitelisted keys, whatever else the sweep wrote', () => {
    const line = opsDigestLine(row({
      detail: { patientName: 'Ravi Rao', internalNotes: 'not for the wire', studyId: 42 },
    }));
    expect(line).toContain('studyId=42');
    expect(line).not.toContain('Ravi');
    expect(line).not.toContain('internalNotes');
  });

  it('skips object and blank values rather than printing [object Object]', () => {
    const line = opsDigestLine(row({
      action: 'dispatch.exhausted',
      entity: 'studies',
      detail: { gap: { missing: ['wados'] }, reason: 'offer_ladder_ended', errorCode: '' },
    }));
    expect(line).not.toContain('gap=');
    expect(line).not.toContain('[object Object]');
    expect(line).toContain('reason=offer_ladder_ended');
    expect(line).not.toContain('errorCode=');
  });

  it('omits the entity id when the row has none', () => {
    expect(opsDigestLine(row({ entityId: null, detail: null })))
      .toBe('2026-10-12T09:14:00.000Z critical.breached critical_events');
  });
});

describe('opsDigestSubject', () => {
  it('counts in plain language and names the boundary', () => {
    expect(opsDigestSubject(1, '2026-10-12T09:00:00.000Z'))
      .toBe('[telrad] 1 ops alert since 2026-10-12T09:00:00.000Z');
    expect(opsDigestSubject(3, null)).toBe('[telrad] 3 ops alerts since startup');
  });
});

describe('opsDigestBody', () => {
  it('carries every row as a line and no key outside the whitelist', () => {
    const body = opsDigestBody([
      row(),
      row({
        id: 8,
        action: 'notify.dead',
        entity: 'report_deliveries',
        entityId: '11',
        detail: { accession: 'ACC-4', attemptNo: 5, errorCode: 'smtp_relay_refused', patientName: 'Ravi Rao' },
      }),
    ], '2026-10-12T09:00:00.000Z');
    expect(body).toContain('critical.breached critical_events#3');
    expect(body).toContain('2026-10-12T09:14:00.000Z notify.dead report_deliveries#11 '
      + 'accession=ACC-4 errorCode=smtp_relay_refused attemptNo=5');
    expect(body).toContain('since the last digest (2026-10-12T09:00:00.000Z)');
    expect(body).not.toContain('Ravi');
  });

  it('says when no digest has gone out before', () => {
    expect(opsDigestBody([row()], null)).toContain('none has been sent before');
  });
});

describe('DETAIL_KEYS', () => {
  it('covers the keys the alert sweeps actually write', () => {
    for (const key of [
      'studyId', 'reportId', 'accession', 'channel', 'recipient', 'conditionCode',
      'receiverName', 'priority', 'reason', 'errorCode', 'attemptNo', 'waitingMinutes', 'slaMinutes',
    ] as const) {
      expect(DETAIL_KEYS).toContain(key);
    }
  });
});
