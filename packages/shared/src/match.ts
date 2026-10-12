import type { LinkState, Priority } from './enums.js';

export type CandidateOrder = {
  orderId: number;
  accessionNumber?: string | null;
  patientName?: string | null;
  patientMrn?: string | null;
  dob?: string | null;
  studyDate?: string | null;
  modalityCode?: string | null;
  siteId?: number | null;
  priority?: Priority | null;
};

export type IncomingStudy = {
  accessionNumber?: string | null;
  patientName?: string | null;
  patientId?: string | null;
  patientBirthDate?: string | null;
  studyDate?: string | null;
  modalityCode?: string | null;
  siteId?: number | null;
};

export type MatchResult = {
  state: LinkState;
  method: 'accession' | 'scored' | 'none';
  orderId: number | null;
  score: number;
  reasons: string[];
};

export const AUTO_LINK_THRESHOLD = 0.85;
export const AMBIGUOUS_THRESHOLD = 0.6;

const SUFFIXES = new Set(['mr', 'ms', 'dr', 'prof', 'md', 'sahib', 'ji', 'rao', 'reddy', 'naidu']);

export function normaliseName(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SUFFIXES.has(t))
    .sort();
}

export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = normaliseName(a), tb = normaliseName(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const hits = ta.filter((t) => setB.has(t)).length;
  return hits / Math.max(ta.length, tb.length);
}

const normAcc = (v: string | null | undefined) => (v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function dayDiff(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(`${a.slice(0, 4)}-${a.slice(4, 6) || '01'}-${a.slice(6, 8) || '01'}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 4)}-${b.slice(4, 6) || '01'}-${b.slice(6, 8) || '01'}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round(Math.abs(da - db) / 86_400_000);
}

export function scoreOrder(study: IncomingStudy, order: CandidateOrder): number {
  const name = nameSimilarity(study.patientName, order.patientName);
  const dates = dayDiff(study.studyDate, order.studyDate);
  const dateScore = dates === null ? 0 : dates === 0 ? 1 : dates === 1 ? 0.7 : dates <= 3 ? 0.3 : 0;
  const dobA = study.patientBirthDate;
  const dobB = order.dob;
  const dobScore = dobA && dobB ? (normDob(dobA) === normDob(dobB) ? 1 : 0) : 0.5;
  const modalityScore = study.modalityCode && order.modalityCode
    ? (study.modalityCode === order.modalityCode ? 1 : 0)
    : 0.5;
  const mrnScore = study.patientId && order.patientMrn
    ? (study.patientId.trim() === order.patientMrn.trim() ? 1 : 0)
    : 0.5;

  return 0.34 * name + 0.2 * dobScore + 0.18 * dateScore + 0.1 * modalityScore + 0.18 * mrnScore;
}

const normDob = (v: string) => v.replace(/[^0-9]/g, '').slice(0, 8);

// The hard floors exist because the weighted score is a convenience, and two
// real patients in the same town on the same day produce a respectable score.
// "Never auto-link against a contradiction" is the rule; the arithmetic is the hint.
export function resolveStudyToOrder(study: IncomingStudy, orders: CandidateOrder[]): MatchResult {
  const reasons: string[] = [];
  const acc = normAcc(study.accessionNumber);

  if (acc) {
    const hits = orders.filter((o) => normAcc(o.accessionNumber) === acc);
    const only = hits.length === 1 ? hits[0] : undefined;
    if (only) {
      return { state: 'linked', method: 'accession', orderId: only.orderId, score: 1, reasons };
    }
    if (hits.length > 1) {
      reasons.push('accession_matches_multiple_orders');
      return { state: 'ambiguous', method: 'none', orderId: null, score: 0, reasons };
    }
    reasons.push('accession_present_but_no_order');
  }

  const contradictions = orders.filter((o) => {
    if (study.patientName && o.patientName && nameSimilarity(study.patientName, o.patientName) === 0) return true;
    if (study.patientBirthDate && o.dob && normDob(study.patientBirthDate) !== normDob(o.dob)) return true;
    if (study.modalityCode && o.modalityCode && study.modalityCode !== o.modalityCode) return true;
    return false;
  });
  const pool = orders.filter((o) => !contradictions.includes(o));
  if (contradictions.length) reasons.push(`excluded_${contradictions.length}_contradictory_orders`);

  const scored = pool
    .map((o) => ({ o, s: scoreOrder(study, o) }))
    .sort((a, b) => b.s - a.s);

  const best = scored[0];
  if (!best) {
    reasons.push('no_candidate_orders');
    return { state: 'orphan', method: 'none', orderId: null, score: 0, reasons };
  }

  const runnerUp = scored[1];
  if (runnerUp && best.s - runnerUp.s < 0.1) {
    reasons.push('two_candidates_within_margin');
    return { state: 'ambiguous', method: 'none', orderId: null, score: best.s, reasons };
  }

  if (best.s >= AUTO_LINK_THRESHOLD) {
    return { state: 'linked', method: 'scored', orderId: best.o.orderId, score: best.s, reasons };
  }
  if (best.s >= AMBIGUOUS_THRESHOLD) {
    return { state: 'ambiguous', method: 'none', orderId: best.o.orderId, score: best.s, reasons };
  }
  reasons.push('below_ambiguous_threshold');
  return { state: 'orphan', method: 'none', orderId: null, score: best.s, reasons };
}

export function unassignableReason(state: LinkState): string | null {
  return state === 'linked' ? null : `link_state_${state}`;
}
