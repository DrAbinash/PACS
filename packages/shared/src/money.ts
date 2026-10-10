import { isNight } from './enums.js';

/**
 * The money rules, with no database and no floats in them.
 *
 * An invoice is the one document in this product that a third party — a center's accounts desk,
 * and later a tax officer — reads and adds up by hand. So the arithmetic is a pure function over
 * integers, the tariff that produced a line is recorded as part of the line, and a study that
 * cannot be priced is reported rather than estimated. Inventing a number is the one thing an
 * invoice cannot afford.
 */

export type Paise = number;

export const PAISE_PER_RUPEE = 100;

/**
 * Money is a count of the smallest unit the currency actually has. A rupee with two decimals is
 * one hundred paise, and once the unit is an integer the only rounding left is the one done
 * deliberately, at the line, exactly once — a float summed down a column drifts by a paise or two
 * and every one of them is a discrepancy somebody has to explain.
 */
export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`rupees must be finite, got ${String(rupees)}`);
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function rupeesOf(paise: Paise): string {
  return (paise / PAISE_PER_RUPEE).toFixed(2);
}

export type TariffRow = {
  id: number;
  modalityCode: string;
  subSpecialtyCode: string | null;
  priority: 'stat' | 'urgent' | 'routine';
  unitPaise: Paise;
  /**
   * The premium, not the multiplier: 25 means the night line is a quarter more than the day line.
   * It is called what the column is called, and the schema's default of 0 means "no premium",
   * which only reads sensibly as a premium.
   */
  nightMultiplierPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: 'draft' | 'active' | 'retired';
};

/**
 * The row that was in force on the day the work was answered — not the row that is active today.
 *
 * `retired` still prices a study delivered while it was in force, because re-billing last March at
 * this March's rate is not a correction, it is a different invoice. Among the rows that cover the
 * moment, a sub-specialty-specific rate beats the generic one, and the later `effectiveFrom` beats
 * the earlier one, which is what makes "the new tariff starts on the 1st" work without deleting
 * the old row.
 *
 * Returns null when nothing covers it. A missing price is reported to the operator as a gap; it is
 * never filled with a guess, and never with the neighbouring modality's number.
 */
export function pickTariff(
  rows: TariffRow[], at: Date, want: {
    modalityCode: string; subSpecialtyCode: string | null; priority: TariffRow['priority'];
  },
): TariffRow | null {
  const covering = rows.filter((t) => t.modalityCode === want.modalityCode
    && t.priority === want.priority
    && (t.subSpecialtyCode === null || t.subSpecialtyCode === want.subSpecialtyCode)
    // A draft has never been in force, so it prices nothing.
    && t.status !== 'draft'
    && t.effectiveFrom.getTime() <= at.getTime()
    && (t.effectiveTo === null || at.getTime() < t.effectiveTo.getTime()));
  if (covering.length === 0) return null;
  const specificity = (t: TariffRow) => (t.subSpecialtyCode === null ? 0 : 1);
  return covering.sort((a, b) => specificity(b) - specificity(a)
    || b.effectiveFrom.getTime() - a.effectiveFrom.getTime()
    // Deterministic even when two rows tie on every rule above, which a duplicated entry can do:
    // an invoice that changes between runs is worse than one that is wrong.
    || b.id - a.id)[0]!;
}

/**
 * The line's money. One rounding, at the end of the multiplication, never twice.
 *
 * A premium on a ₹500 job at 25% is ₹625.00 exactly; at 12% it is ₹560.00; at 7% of ₹143 it is
 * ₹153.01 and the half-paise is decided here and recorded, so the same study re-priced a year
 * later produces the same paise.
 */
export function lineAmount(tariff: TariffRow, at: Date, tenantTzOffsetMinutes: number): Paise {
  const night = isNight(at, tenantTzOffsetMinutes);
  if (!night || tariff.nightMultiplierPct === 0) return tariff.unitPaise;
  return Math.round(tariff.unitPaise * (100 + tariff.nightMultiplierPct) / 100);
}

export type BillableStudy = {
  studyId: number;
  accession: string | null;
  modalityCode: string | null;
  subSpecialtyCode: string | null;
  priority: TariffRow['priority'];
  /** When the clinic was actually answered. Not `received_at`: an image that arrived and was
   *  never reported is a storage cost, not a service delivered, and billing for it would be
   *  billing for something the center did not receive. */
  deliveredAt: Date;
};

export type InvoiceLine = {
  studyId: number;
  description: string;
  amountPaise: Paise;
  tariffId: number | null;
  taxable: boolean;
  night: boolean;
};

export type UnpricedStudy = {
  studyId: number;
  accession: string | null;
  reason: 'no_tariff' | 'no_modality' | 'no_subspecialty';
  modalityCode: string | null;
  subSpecialtyCode: string | null;
  priority: TariffRow['priority'];
};

export function lineDescription(study: BillableStudy, night: boolean): string {
  const acc = study.accession ?? `study ${study.studyId}`;
  const modality = study.modalityCode ?? '—';
  const specialty = study.subSpecialtyCode ?? 'unspecified';
  const priority = study.priority === 'routine' ? '' : `(${study.priority}) `;
  const nightTag = night ? '— night reading ' : '';
  return `${modality} ${specialty} report ${priority}${nightTag}for ${acc}`;
}

/**
 * Turn delivered studies into lines and a list of what could not be priced.
 *
 * One line per study, never one per version: a center that was answered, then corrected, was
 * still answered about one patient, and an amendment that adds a second charge is the kind of
 * invoice dispute that ends a relationship. The correction itself is free, which is also the
 * clinical incentive you want.
 */
export function draftLines(
  studies: BillableStudy[],
  tariffs: TariffRow[],
  tenantTzOffsetMinutes: number,
): { lines: InvoiceLine[]; unpriced: UnpricedStudy[] } {
  const lines: InvoiceLine[] = [];
  const unpriced: UnpricedStudy[] = [];
  for (const study of studies) {
    if (study.modalityCode === null) {
      unpriced.push({
        studyId: study.studyId, accession: study.accession, reason: 'no_modality',
        modalityCode: null, subSpecialtyCode: study.subSpecialtyCode, priority: study.priority,
      });
      continue;
    }
    const tariff = pickTariff(tariffs, study.deliveredAt, {
      modalityCode: study.modalityCode,
      subSpecialtyCode: study.subSpecialtyCode,
      priority: study.priority,
    });
    if (tariff === null) {
      unpriced.push({
        studyId: study.studyId, accession: study.accession, reason: 'no_tariff',
        modalityCode: study.modalityCode, subSpecialtyCode: study.subSpecialtyCode,
        priority: study.priority,
      });
      continue;
    }
    const amount = lineAmount(tariff, study.deliveredAt, tenantTzOffsetMinutes);
    lines.push({
      studyId: study.studyId,
      description: lineDescription(study, isNight(study.deliveredAt, tenantTzOffsetMinutes)),
      amountPaise: amount,
      tariffId: tariff.id,
      // Every reading fee here is one service to one buyer; splitting a study across tax rules
      // would be an accounting decision, not a code decision, so it is a single flag the
      // operator can see on the row.
      taxable: true,
      night: isNight(study.deliveredAt, tenantTzOffsetMinutes),
    });
  }
  return { lines, unpriced };
}

export type Totals = { grossPaise: Paise; taxPaise: Paise; totalPaise: Paise };

/**
 * Tax is computed per line and summed, never computed on the sum.
 *
 * The two differ by a paise whenever a line rounds down, and the difference is the kind that
 * appears on a center's own copy of the invoice and not on ours. `taxPct` is the operator's
 * number — 0 is a legitimate and common answer for a service billed to a hospital's patients —
 * and this module refuses to hold an opinion about which one it is.
 */
export function totals(lines: InvoiceLine[], taxPct: number): Totals {
  let gross = 0;
  let tax = 0;
  for (const line of lines) {
    gross += line.amountPaise;
    if (line.taxable) tax += Math.round(line.amountPaise * taxPct / 100);
  }
  return { grossPaise: gross, taxPaise: tax, totalPaise: gross + tax };
}

/**
 * The financial year an invoice belongs to: April to March, which is the one Indian numbering
 * follows and the one a center's accounts team reconciles against.
 */
export function financialYear(at: Date): { label: string; startYear: number } {
  const month = at.getUTCMonth();
  const startYear = month < 3 ? at.getUTCFullYear() - 1 : at.getUTCFullYear();
  return { label: `${String(startYear).slice(2)}${String((startYear + 1) % 100).padStart(2, '0')}`,
    startYear };
}

/**
 * `WHQ-2627-0007`: tenant code, financial year, sequence.
 *
 * The number is minted at issue and never before, because a deleted draft that had taken number 7
 * would leave a hole in the sequence, and a gap in a GST invoice series is a question that has to
 * be answered in writing. Sequence starts at 1 per tenant per year, which is what "0007" means
 * when read next to the period it covers.
 */
export function invoiceNumber(tenantCode: string, issuedAt: Date, sequence: number): string {
  const code = tenantCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (code === '') throw new Error('a tenant needs a code before it can be invoiced');
  return `${code}-${financialYear(issuedAt).label}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Do two periods overlap? A tenant must not be billed twice for the same window, and "the same
 * window" is a date range, not a calendar month boundary — a second draft for 1–15 Oct while an
 * issued invoice covers 1–31 Oct is a duplicate invoice, not a mid-month run.
 */
export function periodsOverlap(a: { from: Date; to: Date }, b: { from: Date; to: Date }): boolean {
  return a.from.getTime() < b.to.getTime() && b.from.getTime() < a.to.getTime();
}

/**
 * What a period means when it is written as two dates by an operator.
 *
 * `to` is exclusive, so a month is `2026-10-01` to `2026-11-01` and a study delivered at 23:59:59
 * on the last day of October is inside it without anybody reasoning about seconds.
 */
export function periodBounds(from: Date, to: Date): { from: Date; to: Date } | { error: string } {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'bad_period_date' };
  if (to.getTime() <= from.getTime()) return { error: 'period_end_before_start' };
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > 400) return { error: 'period_too_long' };
  return { from, to };
}
