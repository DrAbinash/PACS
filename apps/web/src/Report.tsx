import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  REPORT_SECTIONS, REQUIRED_SECTIONS, missingSections, type ReportSection,
} from '@telrad/shared/report';
import { api, ApiError, type ReportView } from './api';

const LABEL: Record<ReportSection, string> = {
  clinicalHistory: 'Clinical history',
  technique: 'Technique',
  findings: 'Findings',
  impression: 'Impression',
  recommendation: 'Recommendation',
};

const DELIVERY_TEXT: Record<string, string> = {
  not_signed: 'No signature on this version yet, so there is nothing to release.',
  review_required: 'This sub-specialty needs a second name before the clinic can be sent the report.',
  already_delivered: 'Already released to the clinic.',
};

const ROWS: Record<ReportSection, number> = {
  clinicalHistory: 2,
  technique: 2,
  findings: 9,
  impression: 4,
  recommendation: 2,
};

const EMPTY = Object.fromEntries(REPORT_SECTIONS.map((s) => [s, ''])) as Record<ReportSection, string>;

/**
 * The document half of reading a case. A report is the only thing a center is actually
 * bought, so this panel is deliberately narrow: the two fields that carry the answer have
 * to hold words before a signature is offered, saving is a button rather than a reflex,
 * and once a name is on the text the text stops being editable — the way out is an
 * amendment, which keeps the version it corrects.
 */
export default function ReportPanel({ studyId, onChanged }: { studyId: number; onChanged: () => void }) {
  const [report, setReport] = useState<ReportView | null>(null);
  const [shown, setShown] = useState<ReportView | null>(null);
  const [draft, setDraft] = useState<Record<ReportSection, string>>(EMPTY);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const found = await api.reportFor(studyId);
      setReport(found);
      setShown(null);
      setDraft({ ...EMPTY, ...(found?.sections ?? {}) });
      setError(null);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }, [studyId]);

  useEffect(() => { void load(); }, [load]);

  const view = shown ?? report;
  const dirty = useMemo(
    () => report !== null && REPORT_SECTIONS.some((s) => (report?.sections[s] ?? '') !== draft[s]),
    [report, draft],
  );
  // The server's own rule, applied to the words in this box, so the Sign button says no
  // while the reader is still typing instead of refusing after they click.
  const gaps = missingSections(draft);

  async function run(what: () => Promise<ReportView | null>) {
    setBusy(true);
    setError(null);
    try {
      const next = await what();
      if (next) {
        setReport(next);
        setShown(null);
        setDraft({ ...EMPTY, ...next.sections });
      } else {
        // Withdraw leaves no live document to show, so the panel has to ask again rather
        // than keep painting the row it just closed.
        await load();
      }
      onChanged();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return (
      <aside className="report">
        <h3>Report</h3>
        {error && <div className="banner">{error}</div>}
        <p className="sub">{busy ? 'checking…' : 'No report on this case yet.'}</p>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void run(() => api.startReport(studyId).then((r) => r.report))}
        >
          Start the report
        </button>
      </aside>
    );
  }

  const live = shown === null;
  const readOnly = !view.can.edit || !live;

  return (
    <aside className="report">
      <h3>
        Report
        <span className={`state ${tone(view.state)}`}> {view.state}</span>
        <span className="sub"> v{view.version}</span>
      </h3>
      {error && <div className="banner">{error}</div>}

      {shown && (
        <p className="note">
          Viewing version {shown.version}, which is {shown.state}.
          {' '}
          <button className="link" onClick={() => setShown(null)}>back to the current one</button>
        </p>
      )}
      {view.amendmentReason && (
        <p className="note">
          Correction to {view.supersedesVersion === null ? 'an earlier version' : `v${view.supersedesVersion}`}:
          {' '}{view.amendmentReason}
        </p>
      )}

      {REPORT_SECTIONS.map((section) => (
        <label key={section} className="field">
          <span>
            {LABEL[section]}
            {REQUIRED_SECTIONS.includes(section) && <em className="req"> required</em>}
          </span>
          {readOnly ? (
            <p className="text">{view.sections[section] || <span className="sub">nothing written</span>}</p>
          ) : (
            <textarea
              rows={ROWS[section]}
              value={draft[section]}
              onChange={(e) => setDraft((d) => ({ ...d, [section]: e.target.value }))}
            />
          )}
        </label>
      ))}

      {view.can.edit && (
        <div className="acts">
          <button
            disabled={busy || !dirty}
            onClick={() => void run(() => api.saveReport(view.id, draft).then((r) => r.report))}
          >
            Save draft
          </button>
          <button
            className="primary"
            disabled={busy || gaps.length > 0}
            onClick={() => void run(() => api.signReport(view.id).then((r) => r.report))}
          >
            Sign
          </button>
          <button disabled={busy} onClick={() => void run(() => api.withdrawReport(view.id).then(() => null))}>
            Withdraw
          </button>
          {/* The state of the document on the server, said before someone signs it. */}
          <span className="sub">
            {dirty ? 'unsaved words' : 'saved'}
            {gaps.length > 0 && ` · ${gaps.map((g) => LABEL[g]).join(' and ')} still empty`}
          </span>
        </div>
      )}

      {view.can.countersign && (
        <div className="acts">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run(() => api.countersignReport(view.id).then((r) => r.report))}
          >
            Add my second name
          </button>
          {view.study.requiresReviewer && <span className="state amber">this sub-specialty requires a second name</span>}
        </div>
      )}

      {view.can.amend && live && (
        <div className="acts">
          <input
            placeholder="why this needs correcting"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            disabled={busy || reason.trim() === ''}
            onClick={() => void run(() => api.amendReport(view.id, reason.trim()).then((r) => r.report))}
          >
            Amend
          </button>
        </div>
      )}

      {(view.can.showDelivery || view.can.download) && (
        <div className="acts">
          {view.can.showDelivery && (view.can.deliver ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => api.deliverReport(view.id).then((r) => r.report))}
            >
              Deliver to {view.delivery.recipient}
            </button>
          ) : (
            // The reason rather than a missing button. A desk that cannot see why a signed
            // report has not gone out will assume the system forgot it.
            <span className="state amber">
              {view.delivery.decision
                ? DELIVERY_TEXT[view.delivery.decision] ?? explainCode(view.delivery.decision)
                : 'cannot be released yet'}
            </span>
          ))}
          {view.can.download && (
            <a className="link" href={api.pdfHref(view.id)}>Download the PDF</a>
          )}
          {view.delivery.pdfSha256 && (
            <span className="sub">delivered PDF sha256 {view.delivery.pdfSha256.slice(0, 12)}…</span>
          )}
        </div>
      )}

      <div className="signatures">
        <p>
          <span className="sub">Signed</span>
          <br />
          {view.author.name} · {view.author.registration}
          <br />
          <span className="sub">{view.signedAt ? new Date(view.signedAt).toLocaleString() : 'not signed'}</span>
        </p>
        <p>
          <span className="sub">Second name</span>
          <br />
          {view.reviewer
            ? `${view.reviewer.name} · ${view.reviewer.registration}`
            : view.study.requiresReviewer
              ? <span className="state amber">required, and missing</span>
              : '—'}
          <br />
          <span className="sub">{view.verifiedAt ? new Date(view.verifiedAt).toLocaleString() : ''}</span>
        </p>
      </div>

      {view.history.length > 1 && (
        <div className="history">
          <span className="sub">Every version, including the ones this replaced</span>
          <ul>
            {view.history.map((h) => (
              <li key={h.id}>
                <button
                  className="link"
                  onClick={() => void api.report(h.id)
                    .then((r) => setShown(r.report))
                    .catch((err) => setError(explain(err)))}
                >
                  v{h.version} <span className={`state ${tone(h.state)}`}>{h.state}</span> · {h.authorName}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function tone(state: ReportView['state']): string {
  if (state === 'verified' || state === 'delivered') return 'green';
  if (state === 'signed') return 'amber';
  if (state === 'withdrawn' || state === 'amended') return 'red';
  return '';
}

// Exported separately because the review queue carries the same refusal codes without an
// ApiError behind them, and a reader deciding whether to open a case needs the sentence.
export function explainCode(code: string): string {
  switch (code) {
    case 'not_your_case': return 'A report needs the case on your desk, not merely offered to you.';
    case 'not_the_author': return 'Only the reader who wrote a draft can change it.';
    case 'no_clinician_profile': return 'No clinician profile with a registration number is recorded for you, so nothing you write can be signed. Ask the operator.';
    case 'signed_report_is_immutable': return 'A signed report cannot be edited. Correct it with an amendment.';
    case 'self_review': return 'You signed this one, so you cannot be its second name.';
    case 'grade_below_author': return 'Your grade is below the author’s, so you cannot clear this report.';
    case 'grade_not_above_author': return 'An amendment must come from somebody ranked above the one who signed it.';
    case 'reviewer_has_no_grade': case 'amender_has_no_grade': return 'Your profile has no grade recorded, so the rule cannot be applied to you.';
    case 'author_has_no_grade': return 'The author’s profile has no grade recorded, so nobody can be checked against it.';
    case 'reason_required': return 'An amendment needs a reason. Without one it is indistinguishable from an edit.';
    case 'report_exists': return 'This case already has a report.';
    case 'not_a_draft': return 'That draft has already been signed.';
    case 'not_signed': return 'Nothing on this report is waiting for a second name.';
    case 'review_required': return 'This sub-specialty requires a second name before the clinic can be sent the report.';
    case 'already_delivered': return 'This version has already been released to the clinic.';
    case 'not_deliverable': return 'The state of this report changed under the request, so nothing was released. Reload it.';
    case 'no_report': return 'No report on this case yet.';
    default: return code;
  }
}

export function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return 'cannot reach the server';
  const code = err.code ?? '';
  if (code.startsWith('sections_blank:')) {
    const fields = code.slice('sections_blank:'.length).split(',').map((f) => LABEL[f as ReportSection] ?? f);
    return `Sign is refused until these carry words: ${fields.join(' and ')}.`;
  }
  const known = explainCode(code);
  return known === code ? `${err.status} ${err.message}` : known;
}
