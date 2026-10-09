import { describe, expect, it } from 'vitest';
import {
  CRITICAL_CHANNELS, CRITICAL_CONDITIONS, ackDecision, acknowledgedLate, criticalCondition,
  criticalDeadline, criticalState, criticalText, declareDecision, minutesToAckDeadline,
  type CriticalClock,
} from '../src/criticals.js';

const NOTIFIED = new Date('2026-10-10T03:00:00Z');
const at = (minutes: number) => new Date(NOTIFIED.getTime() + minutes * 60_000);

const ten = CRITICAL_CONDITIONS.find((c) => c.slaMinutes === 10) ?? CRITICAL_CONDITIONS[0]!;

const clock = (over: Partial<CriticalClock> = {}): CriticalClock => ({
  notifiedAt: NOTIFIED,
  slaMinutes: ten.slaMinutes,
  acknowledgedAt: null,
  ...over,
});

/** Every field the declaration rule looks at, filled in, so a test changes one thing. */
const complete = {
  condition: ten.code,
  channel: 'phone',
  receiverName: 'Dr A. Rao',
  receiverPhone: '+919876543210',
  detail: null,
};

describe('the condition catalogue', () => {
  it('is a closed set with no duplicated code', () => {
    const codes = CRITICAL_CONDITIONS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('other');
  });

  it('gives every entry a label worth printing and a deadline worth chasing', () => {
    for (const c of CRITICAL_CONDITIONS) {
      expect(c.label.trim().length).toBeGreaterThan(3);
      expect(c.slaMinutes).toBeGreaterThan(0);
    }
  });

  it('puts the findings that need a clinician awake at the shortest deadline', () => {
    // A number someone has to argue about at contract time should not be an invention of the
    // desk, so the ordering is asserted: bleeding and occlusion are the ten-minute ones, and
    // an unknown malignancy is not.
    const byCode = (code: string) => CRITICAL_CONDITIONS.find((c) => c.code === code)!.slaMinutes;
    expect(byCode('intracranial-haemorrhage')).toBeLessThan(byCode('suspected-malignancy'));
    expect(byCode('pneumothorax')).toBeLessThan(byCode('non-accidental-injury'));
  });

  it('resolves an unknown or missing code to a visible entry rather than to nothing', () => {
    // A stored row must always be renderable, including one written by a catalogue this
    // process no longer has. Falling back to `null` would make the board crash on history.
    expect(criticalCondition('intracranial-haemorrhage').code).toBe('intracranial-haemorrhage');
    expect(criticalCondition('stroke').code).toBe('stroke');
    expect(criticalCondition(null).slaMinutes).toBeGreaterThan(0);
    expect(criticalText('stroke', null)).toContain('not in catalogue');
  });
});

describe('declareDecision', () => {
  it('accepts a complete voice call to a named clinician', () => {
    expect(declareDecision(complete)).toEqual({ ok: true });
  });

  it('refuses a code that is not in the catalogue', () => {
    expect(declareDecision({ ...complete, condition: 'pnuemothorax' }))
      .toEqual({ ok: false, reason: 'unknown_condition' });
    expect(declareDecision({ ...complete, condition: null }))
      .toEqual({ ok: false, reason: 'unknown_condition' });
  });

  it('refuses a finding with nobody told', () => {
    // The blank name is the common real case: a form submitted with the field unfilled.
    expect(declareDecision({ ...complete, receiverName: '   ' }))
      .toEqual({ ok: false, reason: 'receiver_name_required' });
    expect(declareDecision({ ...complete, receiverName: null }))
      .toEqual({ ok: false, reason: 'receiver_name_required' });
  });

  it('requires a number for the channels that reach a person', () => {
    for (const channel of ['phone', 'sms', 'whatsapp'] as const) {
      expect(declareDecision({ ...complete, channel, receiverPhone: '' }))
        .toEqual({ ok: false, reason: 'phone_required_for_channel' });
    }
  });

  it('does not require a number for the channels that record where it was left', () => {
    // `portal` and `email` are evidence of a deposit, not of a contact — a claim the reader
    // can honestly make without a phone number, and one the SLA should not pretend to chase.
    for (const channel of ['portal', 'email'] as const) {
      expect(CRITICAL_CHANNELS).toContain(channel);
      expect(declareDecision({ ...complete, channel, receiverPhone: null })).toEqual({ ok: true });
    }
  });

  it('refuses an unknown channel instead of defaulting it', () => {
    expect(declareDecision({ ...complete, channel: 'carrier-pigeon' }))
      .toEqual({ ok: false, reason: 'channel_required' });
    expect(declareDecision({ ...complete, channel: null }))
      .toEqual({ ok: false, reason: 'channel_required' });
  });

  it('requires the words when the reader chose "other"', () => {
    expect(declareDecision({ ...complete, condition: 'other', detail: '  ' }))
      .toEqual({ ok: false, reason: 'detail_required' });
    expect(declareDecision({ ...complete, condition: 'other', detail: 'Acute bowel ischaemia' }))
      .toEqual({ ok: true });
    // A named condition carries its own description, so the free text stays optional there.
    expect(declareDecision({ ...complete, detail: null })).toEqual({ ok: true });
  });
});

describe('ackDecision', () => {
  it('refuses to re-write the first acknowledgement', () => {
    // The deadline is measured against the *first* "I heard it", and a second one arriving
    // later would move a breach back into compliance.
    expect(ackDecision({ alreadyAcknowledged: true, acknowledgedByName: 'Dr A. Rao' }))
      .toEqual({ ok: false, reason: 'already_acknowledged' });
  });

  it('refuses an acknowledgement from nobody', () => {
    expect(ackDecision({ alreadyAcknowledged: false, acknowledgedByName: ' ' }))
      .toEqual({ ok: false, reason: 'receiver_name_required' });
    expect(ackDecision({ alreadyAcknowledged: false, acknowledgedByName: null }))
      .toEqual({ ok: false, reason: 'receiver_name_required' });
  });

  it('accepts the name of the person who said they heard it', () => {
    expect(ackDecision({ alreadyAcknowledged: false, acknowledgedByName: 'Nurse Thomas' }))
      .toEqual({ ok: true });
  });
});

describe('the acknowledgement clock', () => {
  it('counts the deadline from the notification, not from the report', () => {
    expect(criticalDeadline(clock({ slaMinutes: 30 }))).toEqual(at(30));
  });

  it('is waiting inside the window and breached outside it', () => {
    expect(criticalState(clock(), at(9))).toBe('waiting');
    expect(criticalState(clock(), at(11))).toBe('breached');
    // The exact deadline minute is still inside: a sweep that calls it late one minute early
    // invents a breach that a center will contest.
    expect(criticalState(clock(), at(10))).toBe('waiting');
  });

  it('stays breached after a late acknowledgement', () => {
    // Late is a finding, not a state to be cleaned up. Turning it back to `waiting` on ack
    // would make the board agree with whoever rang back last.
    const late = clock({ acknowledgedAt: at(40) });
    expect(criticalState(late, at(200))).toBe('acknowledged');
    expect(acknowledgedLate(late)).toBe(true);
    expect(acknowledgedLate(clock({ acknowledgedAt: at(4) }))).toBe(false);
    expect(acknowledgedLate(clock())).toBe(false);
  });

  it('counts down, and goes negative once it is overdue', () => {
    expect(minutesToAckDeadline(clock(), at(4))).toBe(6);
    expect(minutesToAckDeadline(clock(), at(16))).toBe(-6);
  });

  it('has nothing left to count down once acknowledged', () => {
    // A negative "minutes to deadline" beside an acknowledged row is how a board reads as
    // late after the loop was closed on time.
    const acked = clock({ acknowledgedAt: at(2) });
    expect(criticalState(acked, at(99))).toBe('acknowledged');
    expect(acknowledgedLate(acked)).toBe(false);
  });
});

describe('criticalText', () => {
  it('prints the catalogue label, and the reader\'s words beside it when there are any', () => {
    expect(criticalText('pneumothorax', null)).toBe('Pneumothorax');
    expect(criticalText('other', 'Acute bowel ischaemia')).toBe('Another finding the reader judges critical — Acute bowel ischaemia');
    expect(criticalText('pneumothorax', '  left side, small  ')).toBe('Pneumothorax — left side, small');
  });
});
