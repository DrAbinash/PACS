import { describe, expect, it } from 'vitest';
import {
  draftLines, financialYear, invoiceNumber, lineAmount, lineDescription, PAISE_PER_RUPEE,
  periodsOverlap, pickTariff, periodBounds, rupeesOf, toPaise, totals,
  type BillableStudy, type TariffRow,
} from '../src/money.js';
import { isNight } from '../src/enums.js';

const IST = 330; // +05:30, the offset the dispatch path already uses for this tenant zone.
const day = (iso: string) => new Date(iso);

const tariff = (over: Partial<TariffRow> = {}): TariffRow => ({
  id: 1,
  modalityCode: 'CT',
  subSpecialtyCode: 'ct-head',
  priority: 'routine',
  unitPaise: 50000,
  nightMultiplierPct: 0,
  effectiveFrom: day('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  status: 'active',
  ...over,
});

const study = (over: Partial<BillableStudy> = {}): BillableStudy => ({
  studyId: 7,
  accession: 'ACC-7',
  modalityCode: 'CT',
  subSpecialtyCode: 'ct-head',
  priority: 'routine',
  deliveredAt: day('2026-10-10T09:00:00Z'), // 14:30 IST — daytime
  ...over,
});

describe('money as integers', () => {
  it('converts rupees to paise once, at the edge where a decimal actually exists', () => {
    expect(toPaise(500)).toBe(50000);
    expect(toPaise(0.5)).toBe(50);
    expect(toPaise(19.99)).toBe(1999);
    expect(PAISE_PER_RUPEE).toBe(100);
  });

  it('refuses to convert a number that is not a number', () => {
    expect(() => toPaise(Number.NaN)).toThrow(/finite/);
    expect(() => toPaise(Infinity)).toThrow(/finite/);
  });

  it('prints two decimals, including for a value that started as one paise', () => {
    expect(rupeesOf(1)).toBe('0.01');
    expect(rupeesOf(50000)).toBe('500.00');
  });
});

describe('which tariff was in force', () => {
  const rows = [tariff({ id: 1 }), tariff({ id: 2, effectiveFrom: day('2026-10-01T00:00:00Z'), unitPaise: 60000 })];

  it('takes the row whose window covers the moment the clinic was answered', () => {
    expect(pickTariff(rows, day('2026-09-15T09:00:00Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })?.id)
      .toBe(1);
    expect(pickTariff(rows, day('2026-10-15T09:00:00Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })?.id)
      .toBe(2);
  });

  it('treats the window as half-open, so two rows cannot both price one instant', () => {
    const split = [
      tariff({ id: 1, effectiveTo: day('2026-10-01T00:00:00Z') }),
      tariff({ id: 2, effectiveFrom: day('2026-10-01T00:00:00Z') }),
    ];
    expect(pickTariff(split, day('2026-09-30T23:59:59Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })?.id)
      .toBe(1);
    expect(pickTariff(split, day('2026-10-01T00:00:00Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })?.id)
      .toBe(2);
  });

  it('prices a study delivered under a retired tariff at that retired tariff', () => {
    // Re-billing last March at this March's rate is not a correction, it is a different invoice.
    const retired = tariff({ id: 3, status: 'retired', effectiveTo: day('2026-06-01T00:00:00Z') });
    expect(pickTariff([retired], day('2026-03-01T09:00:00Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })?.id)
      .toBe(3);
    expect(pickTariff([retired], day('2026-07-01T09:00:00Z'), { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' }))
      .toBeNull();
  });

  it('never prices anything with a draft', () => {
    expect(pickTariff([tariff({ id: 4, status: 'draft' })], day('2026-10-10T09:00:00Z'),
      { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })).toBeNull();
  });

  it('prefers a sub-specialty rate over the generic one for the same modality', () => {
    const generic = tariff({ id: 5, subSpecialtyCode: null, unitPaise: 45000 });
    const specific = tariff({ id: 6, subSpecialtyCode: 'ct-chest', unitPaise: 55000 });
    expect(pickTariff([generic, specific], day('2026-10-10T09:00:00Z'),
      { modalityCode: 'CT', subSpecialtyCode: 'ct-chest', priority: 'routine' })?.id).toBe(6);
  });

  it('falls back to the generic rate when nothing covers the sub-specialty', () => {
    const generic = tariff({ id: 5, subSpecialtyCode: null });
    expect(pickTariff([generic], day('2026-10-10T09:00:00Z'),
      { modalityCode: 'CT', subSpecialtyCode: 'ct-spine', priority: 'routine' })?.id).toBe(5);
  });

  it('does not borrow the neighbouring modality or priority', () => {
    // A silent fallback to MRI pricing would put a number on the invoice that nobody agreed for CT.
    expect(pickTariff([tariff({ id: 8, modalityCode: 'MRI' })], day('2026-10-10T09:00:00Z'),
      { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' })).toBeNull();
    expect(pickTariff([tariff({ id: 9, priority: 'routine' })], day('2026-10-10T09:00:00Z'),
      { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'stat' })).toBeNull();
  });

  it('answers the same way twice when two rows tie on every rule', () => {
    const a = tariff({ id: 10, effectiveFrom: day('2026-01-01T00:00:00Z') });
    const b = tariff({ id: 11, effectiveFrom: day('2026-01-01T00:00:00Z') });
    const want = { modalityCode: 'CT', subSpecialtyCode: 'ct-head', priority: 'routine' as const };
    expect(pickTariff([a, b], day('2026-10-10T09:00:00Z'), want)?.id)
      .toBe(pickTariff([b, a], day('2026-10-10T09:00:00Z'), want)?.id);
  });
});

describe('the night premium', () => {
  it('is a premium, not a multiplier: 25 means a quarter more', () => {
    expect(lineAmount(tariff({ unitPaise: 50000, nightMultiplierPct: 25 }),
      day('2026-10-10T18:30:00Z'), IST)).toBe(62500);
  });

  it('is not applied in the daytime, and a zero premium is never applied', () => {
    expect(lineAmount(tariff({ unitPaise: 50000, nightMultiplierPct: 25 }),
      day('2026-10-10T09:00:00Z'), IST)).toBe(50000);
    expect(lineAmount(tariff({ unitPaise: 50000, nightMultiplierPct: 0 }),
      day('2026-10-10T18:30:00Z'), IST)).toBe(50000);
  });

  it('rounds the odd paise once, at the line', () => {
    // 143 rupees at 7% is 153.01 exactly; a second rounding anywhere else would drift.
    expect(lineAmount(tariff({ unitPaise: 14300, nightMultiplierPct: 7 }),
      day('2026-10-10T18:30:00Z'), IST)).toBe(15301);
  });

  it('follows the tenant’s own clock, not the server’s', () => {
    const at = day('2026-10-10T18:30:00Z'); // 00:00 IST, and 18:30 in a zero-offset zone
    expect(isNight(at, IST)).toBe(true);
    expect(isNight(at, 0)).toBe(false);
    // The premium and the label therefore agree, which is the whole reason both read the same
    // exported rule rather than each computing an hour of their own.
    expect(lineAmount(tariff({ nightMultiplierPct: 25 }), at, IST)).toBe(62500);
    expect(lineAmount(tariff({ nightMultiplierPct: 25 }), at, 0)).toBe(50000);
  });
});

describe('drafting the lines', () => {
  it('gives one line per study, whatever the version count was', () => {
    const { lines, unpriced } = draftLines([study()], [tariff()], IST);
    expect(lines).toHaveLength(1);
    expect(unpriced).toEqual([]);
    expect(lines[0]).toMatchObject({ studyId: 7, amountPaise: 50000, tariffId: 1, taxable: true });
  });

  it('names the accession, the modality and the priority in the description', () => {
    const lines = draftLines([study({ priority: 'urgent' })], [tariff({ priority: 'urgent' })], IST).lines;
    expect(lines[0]!.description).toBe('CT ct-head report (urgent) for ACC-7');
  });

  it('says night reading on the line that carries the premium, so the center can see why', () => {
    const lines = draftLines(
      [study({ deliveredAt: day('2026-10-10T18:30:00Z') })],
      [tariff({ nightMultiplierPct: 25 })], IST,
    ).lines;
    expect(lines[0]!.description).toMatch(/— night reading for ACC-7$/);
    expect(lines[0]!.night).toBe(true);
    expect(lines[0]!.amountPaise).toBe(62500);
  });

  it('reports an unpriced study instead of guessing a number for it', () => {
    const { lines, unpriced } = draftLines([study({ modalityCode: 'USG' })], [tariff()], IST);
    expect(lines).toEqual([]);
    expect(unpriced).toEqual([{
      studyId: 7, accession: 'ACC-7', reason: 'no_tariff', modalityCode: 'USG',
      subSpecialtyCode: 'ct-head', priority: 'routine',
    }]);
  });

  it('calls out a study with no modality at all, which is a data problem not a pricing one', () => {
    const { unpriced } = draftLines([study({ modalityCode: null })], [tariff()], IST);
    expect(unpriced[0]!.reason).toBe('no_modality');
    expect(unpriced[0]!.accession).toBe('ACC-7');
  });

  it('prices each study at the tariff in force on *its own* delivery day', () => {
    const rows = [tariff({ id: 1 }), tariff({ id: 2, effectiveFrom: day('2026-10-01T00:00:00Z'), unitPaise: 60000 })];
    const { lines } = draftLines([
      study({ studyId: 1, deliveredAt: day('2026-09-20T09:00:00Z') }),
      study({ studyId: 2, deliveredAt: day('2026-10-20T09:00:00Z') }),
    ], rows, IST);
    expect(lines.map((l) => l.amountPaise)).toEqual([50000, 60000]);
    expect(lines.map((l) => l.tariffId)).toEqual([1, 2]);
  });
});

describe('the totals', () => {
  const line = (paise: number, taxable = true) => ({
    studyId: 1, description: 'x', amountPaise: paise, tariffId: 1, taxable, night: false,
  });

  it('adds nothing when the operator set no tax', () => {
    expect(totals([line(50000), line(60000)], 0))
      .toEqual({ grossPaise: 110000, taxPaise: 0, totalPaise: 110000 });
  });

  it('rounds tax per line and sums, which is what the center’s own copy will show', () => {
    // Three lines of 143.00 at 18%: per-line 25.74 each = 2574 × 3 = 7722.
    // Rounding the sum instead would give 7722 here and differ elsewhere; the rule is per line.
    const t = totals([line(14300), line(14300), line(14300)], 18);
    expect(t.taxPaise).toBe(7722);
    expect(t.grossPaise).toBe(42900);
    expect(t.totalPaise).toBe(50622);
  });

  it('leaves a non-taxable line out of the tax and keeps it in the gross', () => {
    const t = totals([line(50000), line(20000, false)], 18);
    expect(t.grossPaise).toBe(70000);
    expect(t.taxPaise).toBe(9000);
  });

  it('is zero for nothing, not undefined', () => {
    expect(totals([], 18)).toEqual({ grossPaise: 0, taxPaise: 0, totalPaise: 0 });
  });
});

describe('the number an invoice is issued under', () => {
  it('is the tenant code, the Indian financial year, and a sequence', () => {
    expect(invoiceNumber('whq', day('2026-10-10T00:00:00Z'), 7)).toBe('WHQ-2627-0007');
  });

  it('uses the April-to-March year, so January is still the previous financial year', () => {
    expect(financialYear(day('2026-01-15T00:00:00Z')).label).toBe('2526');
    expect(financialYear(day('2026-04-01T00:00:00Z')).label).toBe('2627');
    expect(financialYear(day('2026-03-31T00:00:00Z')).label).toBe('2526');
  });

  it('strips what a code cannot carry rather than producing a broken document number', () => {
    expect(invoiceNumber('Web HQ', day('2026-10-10T00:00:00Z'), 1)).toBe('WEBHQ-2627-0001');
    expect(() => invoiceNumber('—', day('2026-10-10T00:00:00Z'), 1)).toThrow(/needs a code/);
  });

  it('pads the sequence, because 10 sorts between 1 and 2 in a text column', () => {
    expect(invoiceNumber('whq', day('2026-10-10T00:00:00Z'), 1234)).toBe('WHQ-2627-1234');
  });
});

describe('the period being billed', () => {
  it('treats the end as exclusive, so a whole month needs no second-level reasoning', () => {
    const bounds = periodBounds(day('2026-10-01T00:00:00Z'), day('2026-11-01T00:00:00Z'));
    expect(bounds).toEqual({ from: day('2026-10-01T00:00:00Z'), to: day('2026-11-01T00:00:00Z') });
  });

  it('refuses an empty or reversed period', () => {
    expect(periodBounds(day('2026-10-10T00:00:00Z'), day('2026-10-10T00:00:00Z')))
      .toEqual({ error: 'period_end_before_start' });
    expect(periodBounds(day('2026-10-10T00:00:00Z'), day('2026-10-01T00:00:00Z')))
      .toEqual({ error: 'period_end_before_start' });
    expect(periodBounds(new Date('nonsense'), day('2026-10-01T00:00:00Z')))
      .toEqual({ error: 'bad_period_date' });
  });

  it('refuses a run so long it is not a billing period', () => {
    expect(periodBounds(day('2020-01-01T00:00:00Z'), day('2026-10-01T00:00:00Z')))
      .toEqual({ error: 'period_too_long' });
  });

  it('catches a duplicate invoice that a calendar-month UI would let through', () => {
    const issued = { from: day('2026-10-01T00:00:00Z'), to: day('2026-11-01T00:00:00Z') };
    expect(periodsOverlap({ from: day('2026-10-10T00:00:00Z'), to: day('2026-10-15T00:00:00Z') }, issued))
      .toBe(true);
    expect(periodsOverlap({ from: day('2026-11-01T00:00:00Z'), to: day('2026-12-01T00:00:00Z') }, issued))
      .toBe(false);
    expect(periodsOverlap({ from: day('2026-09-01T00:00:00Z'), to: day('2026-10-01T00:00:00Z') }, issued))
      .toBe(false);
  });
});
