import { and, asc, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit, invoiceLines, invoices, modalities, subSpecialties, tariffs, tenants,
} from '@telrad/db';
import {
  cleanText,
  draftLines, financialYear, invoiceNumber, periodsOverlap, periodBounds, rupeesOf,
  totals, tzOffsetMinutes, type BillableStudy, type Paise, type TariffRow,
} from '@telrad/shared';
import { Router, type Response } from 'express';
import { requireAuth, requireRole, scoped, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

/**
 * The money side: what a study costs, and the document that asks a center for it.
 *
 * Two rules shape every route here. Money is calculated from stored integers and never accepted
 * from a caller — the request that creates an invoice names a period, and the arithmetic is
 * re-derived from the reports, the tariffs and the tenant's own clock. And issuing is final:
 * `issued` is the state where a center's accounts team has the number, so the routes refuse to
 * change a line after it, and a correction is a new document rather than an edit to an old one.
 */

const OPERATOR = ['owner', 'console'];
const SETTINGS_TAX_KEY = 'billing.taxPct';

const intOr = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Only whole paise, never a float.
 *
 * `500.004` rupees is refused rather than rounded to `500.00`: a price the operator typed is a
 * term of a contract, and the one thing an invoice cannot carry is a number that changed on the
 * way in. The tolerance is for binary floats — `0.07 * 100` is `7.000000000000001`, and a guard
 * with no tolerance would reject a legitimate seven-paise price.
 */
const paiseFromRupees = (value: unknown): Paise | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const scaled = n * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
};

/**
 * The price as it arrives, from either field, and never both multiplied twice.
 *
 * `unitRupees` and `unitPaise` are alternative spellings of the same number, so they are read by
 * name: `req.body.unitRupees ?? req.body.unitPaise` would feed a paise figure into the rupee
 * conversion and quote a ₹800 study as ₹80,000.
 */
function priceFrom(body: { unitRupees?: unknown; unitPaise?: unknown }): Paise | null {
  if (body.unitPaise !== undefined && body.unitRupees !== undefined) {
    const r = paiseFromRupees(body.unitRupees);
    const p = Number(body.unitPaise);
    if (r === null || !Number.isInteger(p) || r !== p) return null;
    return r;
  }
  if (body.unitRupees !== undefined) return paiseFromRupees(body.unitRupees);
  if (body.unitPaise !== undefined) {
    const p = Number(body.unitPaise);
    return Number.isInteger(p) && p >= 0 ? p : null;
  }
  return null;
}

async function taxPct(db: Db, tenantId: number): Promise<number> {
  const [row] = await db.execute<{ value: unknown }>(
    sql`select value from telrad.settings where key = ${`${SETTINGS_TAX_KEY}.${tenantId}`}`,
  );
  const raw = (row as unknown as { value?: unknown })?.value;
  const pct = typeof raw === 'number' ? raw : Number((raw as { pct?: unknown } | null)?.pct ?? NaN);
  // Absent means 0, not "assume 18". Whether a reading fee to a hospital's patients is taxable is
  // the tenant's accountant's answer, and a number invented here would be on every invoice.
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : 0;
}

async function tenantOf(db: Db, tenantId: number) {
  const [row] = await db.select({
    id: tenants.id, code: tenants.code, timezone: tenants.timezone, legalName: tenants.legalName,
  }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row ?? null;
}

/**
 * The studies a period owes money for.
 *
 * `deliveredAt` is the *first* version's delivery, taken from the report rows themselves: a study
 * that was answered, then corrected, was still answered about one patient, and the amendment must
 * not become a second charge. A study that never reached `delivered` is not here at all, because
 * an image nobody reported is storage the center is using, not a service they bought.
 */
async function billableIn(
  db: Db, tenantId: number, from: Date, to: Date,
): Promise<BillableStudy[]> {
  const rows = await db.execute<{
    studyId: number; accession: string | null; modalityCode: string | null;
    subSpecialtyCode: string | null; priority: string; deliveredAt: string;
  }>(sql`
    select s.id as "studyId", s.accession_number as "accession",
           s.modality_code as "modalityCode", s.sub_specialty_code as "subSpecialtyCode",
           s.priority, min(r.delivered_at) as "deliveredAt"
      from telrad.studies s
      join telrad.reports r on r.study_id = s.id and r.delivered_at is not null
     where s.tenant_id = ${tenantId}
       and s.link_state = 'linked'
     group by s.id, s.accession_number, s.modality_code, s.sub_specialty_code, s.priority
    having min(r.delivered_at) >= ${from.toISOString()}::timestamptz
       and min(r.delivered_at) < ${to.toISOString()}::timestamptz
     order by min(r.delivered_at), s.id
  `);

  return rows.map((row) => ({
    studyId: row.studyId,
    accession: row.accession,
    modalityCode: row.modalityCode,
    subSpecialtyCode: row.subSpecialtyCode,
    priority: row.priority as 'routine' | 'urgent' | 'stat',
    deliveredAt: new Date(row.deliveredAt),
  }));
}

async function tariffRows(db: Db, tenantId: number): Promise<TariffRow[]> {
  const rows = await db.select().from(tariffs)
    .where(eq(tariffs.tenantId, tenantId))
    .orderBy(desc(tariffs.effectiveFrom));
  return rows.map((t) => ({
    id: t.id,
    modalityCode: t.modalityCode,
    subSpecialtyCode: t.subSpecialtyCode,
    priority: t.priority,
    unitPaise: t.unitPaise,
    nightMultiplierPct: t.nightMultiplierPct,
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
    status: t.status,
  }));
}

function scopeFor(req: Ctx): number | null {
  if (req.principal!.role === 'owner' || req.principal!.role === 'console') {
    const raw = Number(req.query.tenantId ?? req.body?.tenantId);
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  return req.principal!.tenantId;
}

/**
 * A path id that is not an integer answers 400 here rather than reaching Postgres.
 *
 * `Number('7.csv')` is NaN, and a NaN in an integer column comparison is a driver error and a
 * 500 — which is what the export path used to be, because Express matches `/billing/invoices/:id`
 * against `/billing/invoices/7.csv` too.
 */
const parseId = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function billingRouter(db: Db): Router {
  const r = Router();
  r.use(scoped(['/billing'], requireAuth(db)));

  const needTenant = (req: Ctx, res: Response) => {
    const tenantId = scopeFor(req);
    if (tenantId === null) {
      res.status(422).json({ ok: false, error: 'tenant_required' });
      return null;
    }
    return tenantId;
  };

  // ---- tariffs -----------------------------------------------------------------------------

  r.get('/billing/tariffs', ah(async (req: Ctx, res) => {
    const tenantId = needTenant(req, res);
    if (tenantId === null) return undefined;
    const rows = await db.select().from(tariffs)
      .where(eq(tariffs.tenantId, tenantId))
      .orderBy(desc(tariffs.effectiveFrom), asc(tariffs.modalityCode), asc(tariffs.priority));
    res.json({
      ok: true,
      tariffs: rows.map((t) => ({
        id: t.id, modalityCode: t.modalityCode, subSpecialtyCode: t.subSpecialtyCode,
        priority: t.priority, unitRupees: rupeesOf(t.unitPaise), unitPaise: t.unitPaise,
        nightMultiplierPct: t.nightMultiplierPct, currency: t.currency,
        effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo, status: t.status,
      })),
    });
  }));

  r.post('/billing/tariffs', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const tenantId = Number(req.body?.tenantId);
    if (!Number.isInteger(tenantId)) return res.status(422).json({ ok: false, error: 'tenant_required' });
    const tenant = await tenantOf(db, tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });

    const modalityCode = cleanText(req.body?.modalityCode ?? '', 8).toUpperCase();
    const subSpecialtyCode = cleanText(req.body?.subSpecialtyCode ?? '', 32) || null;
    const priorityRaw = cleanText(req.body?.priority ?? 'routine', 8).toLowerCase();
    if (!['stat', 'urgent', 'routine'].includes(priorityRaw)) {
      return res.status(422).json({ ok: false, error: 'bad_priority' });
    }
    const priority = priorityRaw as TariffRow['priority'];
    const [modality] = await db.select({ code: modalities.code }).from(modalities)
      .where(eq(modalities.code, modalityCode)).limit(1);
    if (!modality) return res.status(422).json({ ok: false, error: 'unknown_modality' });
    if (subSpecialtyCode !== null) {
      const [sub] = await db.select({ code: subSpecialties.code }).from(subSpecialties)
        .where(eq(subSpecialties.code, subSpecialtyCode)).limit(1);
      if (!sub) return res.status(422).json({ ok: false, error: 'unknown_sub_specialty' });
    }

    const unitPaise = priceFrom(req.body ?? {});
    if (unitPaise === null || unitPaise <= 0) {
      return res.status(422).json({ ok: false, error: 'bad_unit_price' });
    }
    const nightPct = intOr(req.body?.nightMultiplierPct, 0);
    if (nightPct < 0 || nightPct > 500) return res.status(422).json({ ok: false, error: 'bad_night_premium' });
    const effectiveFrom = new Date(String(req.body?.effectiveFrom ?? ''));
    if (Number.isNaN(effectiveFrom.getTime())) {
      return res.status(422).json({ ok: false, error: 'bad_effective_from' });
    }

    const sameKey = [
      eq(tariffs.tenantId, tenantId),
      eq(tariffs.modalityCode, modalityCode),
      sql`coalesce(${tariffs.subSpecialtyCode}, '') = coalesce(${subSpecialtyCode}, '')`,
      eq(tariffs.priority, priority),
    ];

    // The same key on the same starting day is the unique index's question, and it gets its own
    // answer: two prices for one day are not a window overlap, they are the same row entered twice.
    const sameStart = await db.select({ id: tariffs.id }).from(tariffs)
      .where(and(...sameKey, sql`${tariffs.effectiveFrom} = ${effectiveFrom.toISOString()}::timestamptz`))
      .limit(1);
    if (sameStart[0]) {
      return res.status(409).json({ ok: false, error: 'tariff_already_exists_for_that_start',
        clashesWith: sameStart[0].id });
    }

    // A new row that starts *before* an existing one is the ambiguity worth refusing: two rows
    // would then cover every moment after the later start, and activation closes only the older
    // one — so which price wins would be decided by a sort rather than by the operator. A row that
    // starts *after* one is not an ambiguity, it is a price change ("the new rate applies from the
    // 1st"), so it is allowed and its predecessor is closed when this row is activated.
    const clash = await db.select({ id: tariffs.id, from: tariffs.effectiveFrom }).from(tariffs)
      .where(and(
        ...sameKey,
        sql`${tariffs.status} <> 'retired'`,
        sql`${tariffs.effectiveFrom} > ${effectiveFrom.toISOString()}::timestamptz`,
        sql`(${tariffs.effectiveTo} is null or ${tariffs.effectiveTo} > ${effectiveFrom.toISOString()}::timestamptz)`,
      )).limit(1);
    if (clash[0]) {
      return res.status(409).json({
        ok: false, error: 'tariff_window_overlaps', clashesWith: clash[0].id,
        note: 'a new rate must start after the row it replaces; activate closes the older window',
      });
    }

    let row;
    try {
      [row] = await db.insert(tariffs).values({
        tenantId, modalityCode, subSpecialtyCode, priority,
        currency: 'INR', unitPaise, nightMultiplierPct: nightPct, effectiveFrom,
        status: 'draft',
      }).returning();
    } catch (err) {
      // The unique index on (tenant, modality, sub-specialty, priority, effective_from) is the
      // backstop for two rows claiming the same starting day. Say which row it collided with
      // rather than handing the driver's text to the operator.
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ ok: false, error: 'tariff_already_exists_for_that_start' });
      }
      throw err;
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'billing.tariff_created', entity: 'tariffs', entityId: String(row!.id),
      detail: {
        modalityCode, subSpecialtyCode, priority, unitPaise, nightMultiplierPct: nightPct,
        effectiveFrom: effectiveFrom.toISOString(),
      },
    });
    res.status(201).json({ ok: true, tariff: { ...row!, unitRupees: rupeesOf(row!.unitPaise) } });
  }));

  /**
   * Activating a tariff retires the row it replaces, in the same act.
   *
   * A price change that leaves the old row active is two prices for one modality, and the one
   * that wins would be decided by a sort. Here the old row keeps its window — closed at the new
   * one's start — so a study delivered last month still prices at the rate that was in force then.
   */
  r.post('/billing/tariffs/:id/activate', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const [row] = await db.select().from(tariffs).where(eq(tariffs.id, id)).limit(1);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.status === 'active') return res.status(422).json({ ok: false, error: 'already_active' });

    const retired = await db.update(tariffs).set({ status: 'active' })
      .where(and(eq(tariffs.id, id), sql`${tariffs.status} <> 'active'`))
      .returning({ id: tariffs.id });
    if (retired.length === 0) return res.status(409).json({ ok: false, error: 'changed_underneath' });

    const closed = await db.update(tariffs)
      .set({ status: 'retired', effectiveTo: row.effectiveFrom })
      .where(and(
        eq(tariffs.tenantId, row.tenantId),
        eq(tariffs.modalityCode, row.modalityCode),
        sql`coalesce(${tariffs.subSpecialtyCode}, '') = coalesce(${row.subSpecialtyCode}, '')`,
        eq(tariffs.priority, row.priority),
        eq(tariffs.status, 'active'),
        sql`${tariffs.id} <> ${id}`,
        sql`${tariffs.effectiveFrom} < ${row.effectiveFrom.toISOString()}::timestamptz`,
      ))
      .returning({ id: tariffs.id });

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'billing.tariff_activated', entity: 'tariffs', entityId: String(id),
      detail: { retiredTariffs: closed.map((c) => c.id), unitPaise: row.unitPaise },
    });
    res.json({ ok: true, id, retiredTariffs: closed.map((c) => c.id) });
  }));

  r.post('/billing/tariffs/:id/retire', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const at = new Date(String(req.body?.effectiveTo ?? new Date().toISOString()));
    if (Number.isNaN(at.getTime())) return res.status(422).json({ ok: false, error: 'bad_effective_to' });
    const [row] = await db.select().from(tariffs).where(eq(tariffs.id, id)).limit(1);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.status === 'retired') return res.status(422).json({ ok: false, error: 'already_retired' });

    await db.update(tariffs).set({ status: 'retired', effectiveTo: at }).where(eq(tariffs.id, id));
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'billing.tariff_retired', entity: 'tariffs', entityId: String(id),
      detail: { effectiveTo: at.toISOString() },
    });
    res.json({ ok: true, id, effectiveTo: at });
  }));

  // ---- the draft preview ---------------------------------------------------------------------

  /**
   * What a period would cost, without writing anything.
   *
   * The unpriced list is the point of this route. A study with no tariff in force is not silently
   * dropped and not priced at a neighbouring rate: it is named, with its accession, so the
   * operator either adds the rate or accepts that this period does not bill for it.
   */
  r.get('/billing/preview', ah(async (req: Ctx, res) => {
    const tenantId = needTenant(req, res);
    if (tenantId === null) return undefined;
    const bounds = periodBounds(new Date(String(req.query.from ?? '')), new Date(String(req.query.to ?? '')));
    if ('error' in bounds) return res.status(422).json({ ok: false, error: bounds.error });
    const tenant = await tenantOf(db, tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });

    const [billable, rows, pct] = await Promise.all([
      billableIn(db, tenantId, bounds.from, bounds.to),
      tariffRows(db, tenantId),
      taxPct(db, tenantId),
    ]);
    const offset = tzOffsetMinutes(tenant.timezone, new Date());
    const drafted = draftLines(billable, rows, offset);
    const sum = totals(drafted.lines, pct);
    // The date that decided the price travels with the line, because "why is this one ₹1,000 and
    // the one above it ₹800" is the first question a center's accounts desk asks, and the answer is
    // a date rather than an opinion.
    const deliveredById = new Map(billable.map((b) => [b.studyId, b.deliveredAt]));

    res.json({
      ok: true, tenantId, period: bounds, timezone: tenant.timezone, taxPct: pct,
      deliveredStudies: billable.length,
      lines: drafted.lines.map((l) => ({
        ...l, amountRupees: rupeesOf(l.amountPaise),
        deliveredAt: deliveredById.get(l.studyId) ?? null,
        tzOffsetMinutes: offset,
      })),
      unpriced: drafted.unpriced,
      totals: { ...sum, grossRupees: rupeesOf(sum.grossPaise), taxRupees: rupeesOf(sum.taxPaise),
        totalRupees: rupeesOf(sum.totalPaise) },
    });
  }));

  // ---- invoices -----------------------------------------------------------------------------

  r.post('/billing/invoices', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const tenantId = Number(req.body?.tenantId);
    if (!Number.isInteger(tenantId)) return res.status(422).json({ ok: false, error: 'tenant_required' });
    const bounds = periodBounds(new Date(String(req.body?.periodStart ?? '')), new Date(String(req.body?.periodEnd ?? '')));
    if ('error' in bounds) return res.status(422).json({ ok: false, error: bounds.error });
    const tenant = await tenantOf(db, tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });

    // One bill per window per tenant, whatever it is called. A month split into two drafts is the
    // same money asked twice, and it is the sort of duplicate that is found by a center's
    // accountant rather than by us.
    const existing = await db.select({
      id: invoices.id, number: invoices.number, status: invoices.status,
      periodStart: invoices.periodStart, periodEnd: invoices.periodEnd,
    }).from(invoices).where(and(eq(invoices.tenantId, tenantId),
      or(eq(invoices.status, 'draft'), eq(invoices.status, 'issued'), eq(invoices.status, 'paid'))));
    const clash = existing.find((e) => periodsOverlap(bounds, { from: e.periodStart, to: e.periodEnd }));
    if (clash) {
      return res.status(409).json({ ok: false, error: 'period_already_billed', invoiceId: clash.id,
        invoiceNumber: clash.number, status: clash.status });
    }

    const [billable, rows, pct] = await Promise.all([
      billableIn(db, tenantId, bounds.from, bounds.to),
      tariffRows(db, tenantId),
      taxPct(db, tenantId),
    ]);
    const drafted = draftLines(billable, rows, tzOffsetMinutes(tenant.timezone, new Date()));
    if (drafted.lines.length === 0) {
      return res.status(422).json({ ok: false, error: 'nothing_billable_in_period',
        unpriced: drafted.unpriced, deliveredStudies: billable.length });
    }
    const sum = totals(drafted.lines, pct);

    const [invoice] = await db.insert(invoices).values({
      // A draft has no number: minting one at draft time is how a deleted draft leaves a hole in
      // a GST sequence, and a gap is a question that has to be answered in writing.
      number: `draft-${tenant.code}-${Date.now().toString(36)}`,
      tenantId, periodStart: bounds.from, periodEnd: bounds.to, currency: 'INR',
      grossPaise: sum.grossPaise, taxPaise: sum.taxPaise, status: 'draft',
    }).returning();

    for (const line of drafted.lines) {
      await db.insert(invoiceLines).values({
        invoiceId: invoice!.id, studyId: line.studyId, description: line.description,
        amountPaise: line.amountPaise, tariffId: line.tariffId, taxable: line.taxable,
      });
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'billing.invoice_drafted', entity: 'invoices', entityId: String(invoice!.id),
      detail: { period: bounds, lines: drafted.lines.length, grossPaise: sum.grossPaise,
        taxPaise: sum.taxPaise, taxPct: pct, unpriced: drafted.unpriced.length },
    });
    res.status(201).json({ ok: true, id: invoice!.id, lines: drafted.lines.length,
      unpriced: drafted.unpriced, totals: sum });
  }));

  r.get('/billing/invoices', ah(async (req: Ctx, res) => {
    const tenantId = needTenant(req, res);
    if (tenantId === null) return undefined;
    const rows = await db.select({
      id: invoices.id, number: invoices.number, status: invoices.status,
      periodStart: invoices.periodStart, periodEnd: invoices.periodEnd,
      grossPaise: invoices.grossPaise, taxPaise: invoices.taxPaise, issuedAt: invoices.issuedAt,
      lineCount: sql<number>`count(${invoiceLines.id})::int`,
    }).from(invoices)
      .leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .where(eq(invoices.tenantId, tenantId))
      .groupBy(invoices.id, invoices.number, invoices.status, invoices.periodStart, invoices.periodEnd,
               invoices.grossPaise, invoices.taxPaise, invoices.issuedAt)
      .orderBy(desc(invoices.periodStart));
    res.json({ ok: true, invoices: rows.map((row) => ({
      ...row, totalPaise: row.grossPaise + row.taxPaise,
      totalRupees: rupeesOf(row.grossPaise + row.taxPaise),
    })) });
  }));

  async function invoiceWithLines(id: number) {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!invoice) return null;
    const lines = await db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.id));
    return { invoice, lines };
  }

  r.get('/billing/invoices/:id', ah(async (req: Ctx, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const found = await invoiceWithLines(id);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
    const tenantId = scopeFor(req);
    if (tenantId !== null && found.invoice.tenantId !== tenantId) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const pct = await taxPct(db, found.invoice.tenantId);
    res.json({
      ok: true,
      invoice: {
        ...found.invoice,
        totalPaise: found.invoice.grossPaise + found.invoice.taxPaise,
        totalRupees: rupeesOf(found.invoice.grossPaise + found.invoice.taxPaise),
      },
      taxPct: pct,
      lines: found.lines.map((l) => ({ ...l, amountRupees: rupeesOf(l.amountPaise) })),
    });
  }));

  /**
   * Issue: mint the number, freeze the document, and write the totals from the lines.
   *
   * The amounts are re-added from the stored lines here rather than trusted from the insert, so
   * the number a center receives is provably the sum of what is on the page. Nothing in this
   * route edits a line: after this point a correction is a new document, because an invoice whose
   * lines move after it was sent is not evidence of anything.
   */
  r.post('/billing/invoices/:id/issue', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const found = await invoiceWithLines(id);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
    if (found.invoice.status !== 'draft') {
      return res.status(422).json({ ok: false, error: `invoice_${found.invoice.status}` });
    }
    if (found.lines.length === 0) return res.status(422).json({ ok: false, error: 'invoice_has_no_lines' });

    const tenant = await tenantOf(db, found.invoice.tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'not_found' });

    const pct = await taxPct(db, found.invoice.tenantId);
    const sum = totals(found.lines.map((l) => ({
      studyId: l.studyId, description: l.description, amountPaise: l.amountPaise,
      tariffId: l.tariffId, taxable: l.taxable, night: false,
    })), pct);

    const issuedAt = new Date();
    const fyStart = new Date(Date.UTC(financialYear(issuedAt).startYear, 3, 1));
    const already = await db.select({ n: invoices.number }).from(invoices)
      .where(and(eq(invoices.tenantId, tenant.id), gte(invoices.issuedAt, fyStart),
        sql`${invoices.status} = 'issued'`));
    const number = invoiceNumber(tenant.code, issuedAt, already.length + 1);

    // The guarded update is the whole immutability claim: two operators pressing Issue on the
    // same draft would otherwise produce two numbers for one document.
    const updated = await db.update(invoices)
      .set({
        status: 'issued', number, issuedAt, grossPaise: sum.grossPaise, taxPaise: sum.taxPaise,
      })
      .where(and(eq(invoices.id, id), eq(invoices.status, 'draft')))
      .returning({ id: invoices.id });
    if (updated.length === 0) return res.status(409).json({ ok: false, error: 'changed_underneath' });

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: tenant.id,
      action: 'billing.invoice_issued', entity: 'invoices', entityId: String(id),
      detail: { number, lines: found.lines.length, grossPaise: sum.grossPaise,
        taxPaise: sum.taxPaise, taxPct: pct, period: { from: found.invoice.periodStart, to: found.invoice.periodEnd } },
    });
    res.json({ ok: true, id, number, totals: { ...sum, totalRupees: rupeesOf(sum.totalPaise) } });
  }));

  r.post('/billing/invoices/:id/dispute', ah(async (req: Ctx, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const found = await invoiceWithLines(id);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
    const tenantId = scopeFor(req);
    if (tenantId !== null && found.invoice.tenantId !== tenantId) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (found.invoice.status !== 'issued') {
      return res.status(422).json({ ok: false, error: `invoice_${found.invoice.status}` });
    }
    const reason = cleanText(req.body?.reason ?? '', 500);
    if (reason === '') return res.status(422).json({ ok: false, error: 'reason_required' });

    await db.update(invoices).set({ status: 'disputed' }).where(eq(invoices.id, id));
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: found.invoice.tenantId,
      action: 'billing.invoice_disputed', entity: 'invoices', entityId: String(id),
      detail: { number: found.invoice.number, reason },
    });
    res.json({ ok: true, id, status: 'disputed' });
  }));

  /** Drop an unissued draft. An issued invoice cannot be deleted — it left the building. */
  r.delete('/billing/invoices/:id', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const [found] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
    if (found.status !== 'draft') return res.status(422).json({ ok: false, error: 'only_a_draft_can_be_dropped' });

    await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    await db.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.status, 'draft')));
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: found.tenantId,
      action: 'billing.draft_dropped', entity: 'invoices', entityId: String(id),
      detail: { period: { from: found.periodStart, to: found.periodEnd }, grossPaise: found.grossPaise },
    });
    res.json({ ok: true, id, dropped: true });
  }));

  /**
   * The center's own copy, as text their accounts system can read.
   *
   * No PDF library here: an invoice a center can import beats one they can only look at, and a
   * CSV is the one format every accounts package in the country already takes. The path is a
   * segment rather than a `.csv` suffix because `:id` would otherwise match `7.csv` first, and
   * the suffix route would be silently dead.
   */
  r.get('/billing/invoices/:id/export.csv', ah(async (req: Ctx, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ ok: false, error: 'bad_id' });
    const found = await invoiceWithLines(id);
    if (!found) return res.status(404).type('text/plain').send('not found');
    const tenantId = scopeFor(req);
    if (tenantId !== null && found.invoice.tenantId !== tenantId) {
      return res.status(404).type('text/plain').send('not found');
    }
    const tenant = await tenantOf(db, found.invoice.tenantId);
    const quote = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = [
      ['invoice_number', 'tenant', 'period_start', 'period_end', 'status', 'line', 'description',
        'amount_rupees'].join(','),
      ...found.lines.map((l, n) => [
        quote(found.invoice.number), quote(tenant?.legalName), quote(found.invoice.periodStart.toISOString()),
        quote(found.invoice.periodEnd.toISOString()), quote(found.invoice.status), quote(n + 1),
        quote(l.description), quote(rupeesOf(l.amountPaise)),
      ].join(',')),
      ['', '', '', '', '', 'TOTAL', 'gross', quote(rupeesOf(found.invoice.grossPaise))].join(','),
      ['', '', '', '', '', 'TOTAL', 'tax', quote(rupeesOf(found.invoice.taxPaise))].join(','),
      ['', '', '', '', '', 'TOTAL', 'payable',
        quote(rupeesOf(found.invoice.grossPaise + found.invoice.taxPaise))].join(','),
    ].join('\n');
    res.type('text/csv')
      .header('content-disposition', `attachment; filename="invoice-${found.invoice.number}.csv"`)
      .send(body);
  }));

  /** The tax rate is an operator decision, recorded as one rather than assumed by the code. */
  r.post('/billing/tax-rate', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, OPERATOR, res)) return undefined;
    const tenantId = Number(req.body?.tenantId);
    const pct = Number(req.body?.taxPct);
    if (!Number.isInteger(tenantId)) return res.status(422).json({ ok: false, error: 'tenant_required' });
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(422).json({ ok: false, error: 'bad_tax_pct' });
    await db.execute(sql`insert into telrad.settings (key, value, updated_at)
                        values (${`${SETTINGS_TAX_KEY}.${tenantId}`}, ${JSON.stringify({ pct })}::jsonb, now())
                        on conflict (key) do update set value = excluded.value, updated_at = now()`);
    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId,
      action: 'billing.tax_rate_set', entity: 'settings', entityId: `${SETTINGS_TAX_KEY}.${tenantId}`,
      detail: { taxPct: pct },
    });
    res.json({ ok: true, tenantId, taxPct: pct });
  }));

  r.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return r;
}
