import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFY_ATTEMPTS, afterAttempt, backoffMinutes, containsNoPatientIdentifiers,
  enqueueDecision, mayAttempt, normaliseEmail, reportReadyBody, reportReadySubject,
  type OutboxRow, type ReportReadyMessage,
} from '../src/notify.js';

const NOW = new Date('2026-10-10T04:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  status: 'pending', attemptNo: 0, nextAttemptAt: NOW, ...over,
});

const message = (over: Partial<ReportReadyMessage> = {}): ReportReadyMessage => ({
  centreName: 'Sparsh Diagnostic Centre',
  tenantCode: 'whq',
  accession: 'ACC-REP-1',
  reportVersion: 2,
  signedAt: '2026-10-10 03:10 UTC',
  hasSecondSignature: true,
  portalUrl: 'https://telrad.example/portal',
  ...over,
});

describe('the retry ladder', () => {
  it('backs off instead of hammering a relay that is down', () => {
    expect(backoffMinutes(1)).toBeLessThan(backoffMinutes(2));
    expect(backoffMinutes(2)).toBeLessThan(backoffMinutes(3));
    expect(backoffMinutes(MAX_NOTIFY_ATTEMPTS)).toBeLessThanOrEqual(480);
  });

  it('clamps outside the table rather than returning undefined', () => {
    // `noUncheckedIndexedAccess` makes an out-of-range index a real risk, and a missing
    // backoff would have to mean "never try again", which is not the same as "retry later".
    expect(backoffMinutes(0)).toBe(1);
    expect(backoffMinutes(99)).toBe(480);
  });

  it('schedules the next try from the attempt that just failed', () => {
    expect(afterAttempt({ attemptNo: 1, ok: false, now: NOW }).nextAttemptAt)
      .toEqual(new Date(NOW.getTime() + 60_000));
    expect(afterAttempt({ attemptNo: 3, ok: false, now: NOW }).nextAttemptAt).toEqual(at(30));
  });

  it('does not pretend a success is a retry', () => {
    expect(afterAttempt({ attemptNo: 2, ok: true, now: NOW })).toEqual({
      status: 'sent', attemptNo: 2, nextAttemptAt: null, errorCode: null,
    });
  });

  it('goes dead on the last attempt instead of leaving an unrepeatable failure', () => {
    // A `failed` row with no next attempt is how a clinic is never told and nothing on any
    // board says so. `dead` is the state a person has to look at.
    const last = afterAttempt({ attemptNo: MAX_NOTIFY_ATTEMPTS, ok: false, errorCode: 'smtp_timeout', now: NOW });
    expect(last.status).toBe('dead');
    expect(last.nextAttemptAt).toBeNull();
    expect(last.errorCode).toBe('smtp_timeout');
    // And one before last is still retryable.
    expect(afterAttempt({ attemptNo: MAX_NOTIFY_ATTEMPTS - 1, ok: false, now: NOW }).status)
      .toBe('failed');
  });

  it('names an error even when the caller had nothing to say', () => {
    expect(afterAttempt({ attemptNo: 1, ok: false, now: NOW }).errorCode).toBe('send_failed');
  });
});

describe('mayAttempt', () => {
  it('attempts a due row and leaves one that is not due alone', () => {
    expect(mayAttempt(row(), NOW)).toBe(true);
    expect(mayAttempt(row({ nextAttemptAt: at(5) }), NOW)).toBe(false);
    expect(mayAttempt(row({ nextAttemptAt: at(-5) }), NOW)).toBe(true);
  });

  it('treats sent and dead as terminal', () => {
    // `dead` in particular: the query filters on it, and if the code disagreed with the query
    // a human would watch a row being retried forever after it was reported as given up on.
    expect(mayAttempt(row({ status: 'sent' }), NOW)).toBe(false);
    expect(mayAttempt(row({ status: 'dead' }), NOW)).toBe(false);
    expect(mayAttempt(row({ status: 'failed' }), NOW)).toBe(true);
  });

  it('attempts a row with no schedule, because a null next-attempt means "as soon as possible"', () => {
    expect(mayAttempt(row({ nextAttemptAt: null }), NOW)).toBe(true);
  });
});

describe('enqueueDecision', () => {
  it('allows a fresh row and refuses to re-open a settled one', () => {
    expect(enqueueDecision(null)).toEqual({ ok: true });
    expect(enqueueDecision(row({ status: 'pending' }))).toEqual({ ok: true });
    expect(enqueueDecision(row({ status: 'failed' }))).toEqual({ ok: true });
    expect(enqueueDecision(row({ status: 'sent' })).ok).toBe(false);
    expect(enqueueDecision(row({ status: 'dead' })).ok).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('accepts the shapes a clinic actually writes down', () => {
    expect(normaliseEmail(' Dr.Rao@GovHosp.Gov.IN ')).toBe('dr.rao@govhosp.gov.in');
    expect(normaliseEmail('radiology-desk+reports@clinic.co.uk')).toBe('radiology-desk+reports@clinic.co.uk');
  });

  it('returns null rather than a wrong address', () => {
    // Nothing is queued on a guess. A `null` here means the desk sees "no address recorded"
    // and can ring the center; a half-parsed string would mean a report mailed to nobody.
    for (const bad of ['', '   ', 'na', 'dr.rao', '@govhosp.in', 'dr@', 'dr@@govhosp.in',
      'dr@govhosp', 'dr @govhosp.in', 'dr@govhosp..in', 'dr@govhosp.in.', null, undefined, 42]) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it('caps the length instead of trusting the column', () => {
    expect(normaliseEmail(`${'a'.repeat(300)}@govhosp.in`)).toBeNull();
  });
});

describe('the message a clinic receives', () => {
  it('says what is ready and where to read it', () => {
    expect(reportReadySubject(message())).toBe('Report ready — ACC-REP-1 (version 2)');
    const body = reportReadyBody(message());
    expect(body).toContain('Sparsh Diagnostic Centre');
    expect(body).toContain('https://telrad.example/portal');
    expect(body).toContain('two signatures');
    expect(body).toContain('no clinical information');
  });

  it('says one signature when no second name is on the document', () => {
    // The rule that demanded a reviewer is a separate fact from a reviewer having signed, and
    // this is the sentence a clinic reads about the document itself.
    expect(reportReadyBody(message({ hasSecondSignature: false })))
      .toContain('carries one signature');
  });

  it('carries no patient identifier, and the guard that checks for one actually catches it', () => {
    const body = reportReadyBody(message());
    expect(containsNoPatientIdentifiers(body, ['Kavita Rao', 'P-REP-1', '1968-07-19'])).toBe(true);
    // The forbidden list is only worth having if a name in the body fails it, so the leak
    // itself is asserted rather than assumed impossible.
    expect(containsNoPatientIdentifiers('Report for Kavita Rao', ['Kavita Rao'])).toBe(false);
    expect(containsNoPatientIdentifiers('Report for Kavita Rao', ['', null, undefined, 'ab']))
      .toBe(true);
  });

  it('does not gain a patient field by accident', () => {
    // The type has no place to put one. This test exists so the next person adds a field to
    // `ReportReadyMessage` knowingly, with the assertion above widened, rather than by pasting
    // a name into a template.
    expect(Object.keys(message()).sort()).toEqual(
      ['accession', 'centreName', 'portalUrl', 'reportVersion', 'hasSecondSignature',
        'signedAt', 'tenantCode'].sort(),
    );
  });
});
