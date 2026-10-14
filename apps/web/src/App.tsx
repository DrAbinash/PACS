import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type BlockedCase,
  type DeliveryItem,
  type LateCase,
  type Panel,
  type PanelRow,
  type PresenceColor,
  type MyReportItem,
  type NoticeItem,
  type ReviewItem,
  type Session,
  type WorkCase,
} from './api';

import Viewer from './Viewer';
import { CriticalBoard } from './Critical';
import { Billing } from './Billing';
import { Performance } from './Performance';
import { SlaTargets } from './SlaTargets';
import { Retention } from './Retention';
import { FilmExports } from './FilmExports';
import { AuditBoard } from './AuditBoard';
import { SearchReports } from './SearchReports';
import { Sites } from './Sites';
import { Orphans } from './Orphans';
import { Tariffs } from './Tariffs';
import { Users } from './Users';
import { explainCode, retryLabel } from './Report';

const HEARTBEAT_MS = 20_000;
const REFRESH_MS = 5_000;
const READER_ROLES = ['radiologist', 'reviewer'];
const OPERATOR_ROLES = ['owner', 'console'];
// Who releases a report to the clinic. Wider than the operator roles because the desk at
// the center is the one that knows whether the referring clinician is waiting for it, and
// narrower than the readers on purpose: the person under time pressure to sign a case is
// not the person who decides it leaves.
const DESK_ROLES = ['center_staff', 'owner', 'console'];
// The refusal codes the delivery decision answers with, in the few words a board row can
// carry. The long sentence belongs next to the button, not in the badge.
const SHORT_REASON: Record<string, string> = {
  review_required: 'awaiting a second name',
  not_signed: 'not signed yet',
  already_delivered: 'already sent',
  critical_unacknowledged: 'a finding is unanswered',
};

type Mine = { color: PresenceColor; code: string; label: string; routable: boolean; openCases: number; maxQueueSize: number };

function ago(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (tempToken) {
        // Second factor step
        const result = await api.totpComplete(tempToken, totpCode, useBackup);
        onSignedIn(result);
      } else {
        // Initial login
        const result = await api.login(email, password);
        if ('requiresTotp' in result && result.requiresTotp) {
          setTempToken(result.tempToken);
        } else {
          onSignedIn(result as Session);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong email or password' : 'Cannot reach the server');
    } finally {
      setBusy(false);
    }
  };

  if (tempToken) {
    return (
      <form className="login card" onSubmit={handleSubmit}>
        <h2>Two-factor authentication</h2>
        <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '1em' }}>
          {useBackup ? 'Enter a backup code' : 'Enter the code from your authenticator app'}
        </p>
        <input
          name="totp"
          type="text"
          inputMode="numeric"
          placeholder={useBackup ? 'backup code' : '6-digit code'}
          value={totpCode}
          onChange={(e) => setTotpCode(e.target.value)}
          autoFocus
          required
        />
        <button className="primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
        <button
          type="button"
          style={{ background: 'none', border: 'none', color: '#0066cc', cursor: 'pointer', fontSize: '0.9em' }}
          onClick={() => { setUseBackup(!useBackup); setTotpCode(''); }}
        >
          {useBackup ? 'Use authenticator app instead' : 'Use a backup code'}
        </button>
        {error && <span className="error">{error}</span>}
      </form>
    );
  }

  return (
    <form className="login card" onSubmit={handleSubmit}>
      <h2>telrad</h2>
      <input name="email" type="email" placeholder="email" autoComplete="username"
        value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input name="password" type="password" placeholder="passphrase" autoComplete="current-password"
        value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function Worklist({ onChanged, onOpen }: { onChanged: () => void; onOpen: (studyId: number) => void }) {
  const [cases, setCases] = useState<WorkCase[]>([]);
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCases((await api.myWork()).cases);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), REFRESH_MS);
    // A countdown that only moves every five seconds looks like a frozen one, and an
    // offer about to lapse is the case a reader most needs an honest clock for.
    const second = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { clearInterval(poll); clearInterval(second); };
  }, [load]);

  const offered = cases.filter((c) => c.state === 'offered');
  const toggle = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  async function bulkAccept() {
    if (picked.size === 0) return;
    setBulkBusy(true);
    setError(null);
    try {
      const res = await api.bulkAccept([...picked]);
      setPicked(new Set());
      await load();
      onChanged();
      if (res.failed > 0) setError(`${res.accepted} accepted, ${res.failed} could not be`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setBulkBusy(false);
    }
  }

  async function accept(id: number) {
    setError(null);
    try {
      await api.accept(id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }

  async function decline(id: number) {
    if (!reason.trim()) return;
    setError(null);
    try {
      await api.decline(id, reason.trim());
      setDeclining(null);
      setReason('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }

  function left(c: WorkCase): string | null {
    if (!c.expiresAt) return null;
    const secs = Math.max(0, Math.round((new Date(c.expiresAt).getTime() - Date.now()) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }

  return (
    <div className="card">
      <h2>Your cases</h2>
      {error && <div className="error">{error}</div>}
      {offered.length > 1 && (
        <div className="filters">
          <button className="primary" disabled={bulkBusy || picked.size === 0} onClick={() => void bulkAccept()}>
            {bulkBusy ? 'Accepting…' : `Accept selected (${picked.size})`}
          </button>
          <button disabled={picked.size === offered.length} onClick={() => setPicked(new Set(offered.map((c) => c.assignmentId)))}>
            Select all offers
          </button>
          <button disabled={picked.size === 0} onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {cases.length === 0 && !error && <div className="sub">Nothing is held by you right now.</div>}
      {cases.map((c) => {
        const remaining = left(c);
        return (
          <div className="workcase" key={c.assignmentId}>
            {c.state === 'offered' && offered.length > 1 && (
              <input type="checkbox" checked={picked.has(c.assignmentId)}
                onChange={() => toggle(c.assignmentId)} />
            )}
            <span className={`priority ${c.priority}`}>{c.priority}</span>
            <div className="who">
              <strong>{c.patientName ?? 'name not carried in the study'}</strong>
              <div className="sub">
                {c.modality} · {c.subSpecialty} · {c.accession ?? 'no accession'} · waiting {c.waitingMinutes} min
              </div>
              <div className="sub">
                {c.state === 'offered'
                  ? `offer lapses in ${remaining ?? '0:00'}${c.attemptNo > 1 ? ` · attempt ${c.attemptNo}` : ''}`
                  : `held since ${c.acceptedAt ? new Date(c.acceptedAt).toLocaleTimeString() : '—'}`}
                {/* A case with a half-written report on it is a different kind of work than
                    one with nothing yet, and the desk has to say which it is looking at. */}
                {c.report && <> · <span className="chip">report {c.report.state} v{c.report.version}</span></>}
              </div>
            </div>
            {c.state === 'offered' && declining !== c.assignmentId && (
              <span className="acts">
                <button className="primary" onClick={() => void accept(c.assignmentId)}>Accept</button>
                <button onClick={() => { setDeclining(c.assignmentId); setReason(''); }}>Decline</button>
              </span>
            )}
            {/* Offered as well as held: looking is how a reader decides whether to accept,
                and an accept that had to be blind would be the one thing the padlock rule
                is not supposed to allow. */}
            <button onClick={() => onOpen(c.studyId)}>Open</button>
            <button
              onClick={() => {
                const url = `${window.location.origin}/study/${c.studyId}`;
                const text = `Study ${c.accession ?? c.studyId} — ${c.modality ?? ''} ${c.patientName ?? ''}`;
                window.open(`https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`, '_blank');
              }}
              title="Share on WhatsApp"
            >Share</button>
            {declining === c.assignmentId && (
              <span className="acts">
                <input placeholder="why (required)" value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void decline(c.assignmentId); }} />
                <button className="primary" disabled={!reason.trim()} onClick={() => void decline(c.assignmentId)}>Send back</button>
                <button onClick={() => setDeclining(null)}>Keep</button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Two names on a report is the rule; a queue is the feature. A reviewer is by definition
// not the reader holding the case — routing keeps exactly one live lock per study — so
// without this list the countersignature would depend on somebody sending a report id in
// a message. Each row says plainly whether the viewer can clear it and why not.
function ReviewQueue({ show, onOpen }: { show: boolean; onOpen: (studyId: number) => void }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [myGrade, setMyGrade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const feed = await api.awaitingReview();
      setItems(feed.awaiting);
      setMyGrade(feed.myGrade);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.code ?? `${err.status}` : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show || (items.length === 0 && !error)) return null;

  return (
    <div className="card">
      <h2>
        Awaiting a second name
        <span className="sub"> · your grade: {myGrade ?? 'not recorded'}</span>
      </h2>
      {error && <div className="error">{error}</div>}
      {items.length === 0 && <div className="sub">Nothing signed is waiting.</div>}
      {items.map((i) => (
        <div className="workcase" key={i.reportId}>
          <div className="who">
            <strong>{i.accession ?? `study ${i.studyId}`}</strong>
            <div className="sub">
              {i.modality ?? '?'} · v{i.version} · signed {i.signedAt ? new Date(i.signedAt).toLocaleTimeString() : '—'}
            </div>
            <div className="sub">author {i.authorName}{i.authorGrade ? ` (${i.authorGrade})` : ' — no grade recorded'}</div>
          </div>
          <span className="acts">
            <button className={i.mayClear ? 'primary' : undefined} onClick={() => onOpen(i.studyId)}>Review</button>
            {!i.mayClear && <span className="state amber">{explainCode(i.reason ?? '')}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// A reader's own signatures, because signing completes the read and takes the case off the
// desk that led to it. Without this the console would show tonight's work and hide what was
// already said, and a reader who wants to check their own report would have no link to
// follow.
function MyReports({ show, onOpen }: { show: boolean; onOpen: (studyId: number) => void }) {
  const [rows, setRows] = useState<MyReportItem[]>([]);
  const [ratingFor, setRatingFor] = useState<number | null>(null);
  const [ratingValue, setRatingValue] = useState(5);
  const [ratingComment, setRatingComment] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.myReports()).reports);
    } catch {
      // The board already carries the "feed lost" banner for an unreachable server.
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS * 2);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show || rows.length === 0) return null;

  return (
    <div className="card">
      <h2>Reports I signed</h2>
      {rows.map((r) => (
        <div className="workcase" key={r.reportId}>
          <div className="who">
            <strong>{r.accession ?? `study ${r.studyId}`}</strong>
            <div className="sub">
              {r.modality ?? '?'} {r.subSpecialty ?? ''} · {r.patientName ?? 'name not carried'} · {r.tenantCode}
            </div>
            <div className="sub">
              v{r.version} · <span className={`state ${r.state === 'verified' || r.state === 'delivered' ? 'green' : r.state === 'signed' ? 'amber' : ''}`}>{r.state}</span>
              {r.signedAt ? ` · signed ${new Date(r.signedAt).toLocaleString()}` : ' · not signed yet'}
              {r.reviewerName ? ` · second name ${r.reviewerName}` : ''}
            </div>
            {r.amendmentReason && <div className="sub">correction: {r.amendmentReason}</div>}
          </div>
          <button onClick={() => onOpen(r.studyId)}>Open</button>
          <button
            onClick={() => {
              const url = `${window.location.origin}/study/${r.studyId}`;
              const text = `Report ${r.accession ?? r.studyId} — ${r.modality ?? ''} ${r.patientName ?? ''}`;
              window.open(`https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`, '_blank');
            }}
            title="Share on WhatsApp"
          >Share</button>
          {ratingFor === r.reportId ? (
            <span className="acts">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setRatingValue(n)}
                  style={{ fontWeight: n === ratingValue ? 'bold' : undefined }}>{n}</button>
              ))}
              <input placeholder="comment (optional)" value={ratingComment}
                onChange={(e) => setRatingComment(e.target.value)} style={{ width: 120 }} />
              <button className="primary" onClick={async () => {
                await api.rateReport(r.reportId, ratingValue, ratingComment.trim() || undefined);
                setRatingFor(null);
                setRatingComment('');
              }}>Save</button>
              <button onClick={() => setRatingFor(null)}>Cancel</button>
            </span>
          ) : (
            <button onClick={() => { setRatingFor(r.reportId); setRatingValue(5); }}>Rate</button>
          )}
        </div>
      ))}
    </div>
  );
}

// What the clinic has not been sent yet. This is the desk's list, and every row carries
// the reason it is still here: a signed MRI waiting on a second name and a signed chest
// film that never needed one both read "not delivered", and only one of them is somebody's
// action. Before delivery existed, a report that had been signed and cleared simply stopped
// appearing anywhere — the reader's desk had released it and the center had no row to look
// at.
function AwaitingDelivery({ show, canOpen, onOpen }: {
  show: boolean;
  // The platform roles can open the images as well as release the document; a center desk
  // account gets the paper, not the patient's studies, which is the narrower permission and
  // the one the viewer enforces.
  canOpen: boolean;
  onOpen: (studyId: number) => void;
}) {
  const [rows, setRows] = useState<DeliveryItem[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsgFor, setActionMsgFor] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.awaitingDelivery()).awaiting);
    } catch {
      // The board already carries the "feed lost" banner for an unreachable server.
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS * 2);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show || rows.length === 0) return null;

  const deliver = async (reportId: number) => {
    setBusy(reportId);
    setError(null);
    try {
      await api.deliverReport(reportId);
      await load();
    } catch (err) {
      setError(explainCode(err instanceof ApiError ? err.code ?? '' : String(err)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h2>Awaiting delivery</h2>
      {error && <div className="error">{error}</div>}
      {rows.map((r) => (
        <div className="workcase" key={r.reportId}>
          <div className="who">
            <strong>{r.accession ?? `study ${r.studyId}`}</strong>
            <div className="sub">
              {r.modality ?? '?'} {r.subSpecialty ?? ''} · {r.patientName ?? 'name not carried'}
              {r.patientMrn ? ` · ${r.patientMrn}` : ''} · {r.tenantCode}
            </div>
            <div className="sub">
              v{r.version} · <span className={`state ${r.state === 'verified' ? 'green' : 'amber'}`}>{r.state}</span>
              {r.signedAt ? ` · signed ${new Date(r.signedAt).toLocaleString()}` : ''}
              {' · to '}
              {r.referringName ?? 'no referring clinician recorded'}
            </div>
            {r.needsSecondName && (
              <div className="sub">blocked: this sub-specialty needs a second name</div>
            )}
          </div>
          {r.deliverable ? (
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => void deliver(r.reportId)}
            >
              {busy === r.reportId ? 'Delivering' : 'Deliver'}
            </button>
          ) : (
            <span className="state amber">
              {(r.reason !== null && SHORT_REASON[r.reason]) ?? r.reason ?? 'cannot be released'}
            </span>
          )}
          {canOpen && <button onClick={() => onOpen(r.studyId)}>Open</button>}
          <a className="link" href={api.pdfHref(r.reportId)}>PDF</a>
          {actionMsgFor === r.reportId ? (
            <span className="acts">
              <input placeholder="what needs attention" value={actionMsg}
                onChange={(e) => setActionMsg(e.target.value)} style={{ width: 160 }} />
              <button className="primary" onClick={async () => {
                await api.setActionNeeded(r.reportId, actionMsg.trim() || undefined);
                setActionMsgFor(null);
                setActionMsg('');
                await load();
              }}>Flag</button>
              <button onClick={() => { setActionMsgFor(null); setActionMsg(''); }}>Cancel</button>
            </span>
          ) : r.actionNeeded ? (
            <span className="acts">
              <span className="state amber">action needed{r.actionNeededMessage ? `: ${r.actionNeededMessage}` : ''}</span>
              <button onClick={async () => {
                await api.clearActionNeeded(r.reportId);
                await load();
              }}>Clear</button>
            </span>
          ) : (
            <button onClick={() => { setActionMsgFor(r.reportId); setActionMsg(''); }}>Action needed</button>
          )}
          <button
            onClick={() => {
              const url = `${window.location.origin}/study/${r.studyId}`;
              const text = `Report ${r.accession ?? r.studyId} — ${r.modality ?? ''} ${r.patientName ?? ''}`;
              window.open(`https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`, '_blank');
            }}
            title="Share on WhatsApp"
          >Share</button>
        </div>
      ))}
    </div>
  );
}

// The notices that have not reached a clinic. A report can be released, correctly, with a
// signature and a hash and an audit row, and the referring doctor can still not know it exists
// — which is the failure this card is the only place in the product that says out loud. `dead`
// rows stay here until a person does something, because a queue that quietly gives up is worse
// than no queue at all.
function NoticeQueue({ show, canOpen, onOpen }: {
  show: boolean;
  canOpen: boolean;
  onOpen: (studyId: number) => void;
}) {
  const [rows, setRows] = useState<NoticeItem[]>([]);

  const load = useCallback(async () => {
    try {
      setRows((await api.notices()).outbox);
    } catch {
      // The board keeps its last list on a dropped feed: a stale queue of notices is still a
      // queue, and the page already carries the banner that says the feed is down.
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS * 3);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show || rows.length === 0) return null;
  const dead = rows.filter((r) => r.status === 'dead').length;

  return (
    <div className="card">
      <h2>
        Notices waiting
        <span className={`count ${dead > 0 ? 'amber' : 'green'}`}>
          {rows.length} unsent{dead > 0 ? ` · ${dead} given up on` : ''}
        </span>
      </h2>
      {rows.map((n) => (
        <div className="workcase" key={n.id}>
          <div className="who">
            <strong>{n.accession ?? `report ${n.reportId}`}</strong>
            <div className="sub">
              v{n.version} · <span className={`state ${n.status === 'dead' ? 'red' : n.status === 'failed' ? 'amber' : ''}`}>{n.status}</span>
              {' · '}{n.channel} to {n.recipient}
            </div>
            <div className="sub">
              attempt {n.attemptNo}
              {` · ${retryLabel(n.nextAttemptAt)}`}
              {n.errorCode ? ` · ${n.errorCode}` : ''}
              {n.tenantCode ? ` · ${n.tenantCode}` : ''}
            </div>
          </div>
          {canOpen && <button onClick={() => onOpen(n.studyId)}>Open</button>}
        </div>
      ))}
    </div>
  );
}

// The operator's other half of the board: not who is free, but what is running out and
// whether the system has done anything about it yet. A case that cannot be routed shows
// the closest reader and the reason they were skipped, because "unassigned" on its own is
// not an answer anyone can act on at 2 a.m.
function Waiting({ show, panel, onOpen }: {
  show: boolean;
  // The routing dropdown reads the same presence feed the board above renders, so a name
  // offered here is a name the desk can see is green somewhere above it.
  panel: PanelRow[];
  onOpen: (studyId: number) => void;
}) {
  const [late, setLate] = useState<LateCase[]>([]);
  const [blocked, setBlocked] = useState<BlockedCase[]>([]);
  const [unheld, setUnheld] = useState(0);
  const [reviewWaiting, setReviewWaiting] = useState<{
    reportId: number; studyId: number; tenant: string | null; accession: string | null;
    modality: string | null; subSpecialty: string | null; signedAt: string | null;
    authorName: string; waitingMinutes: number | null;
  }[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [readerId, setReaderId] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);

  useEffect(() => {
    if (!show) return;
    let live = true;
    const load = async () => {
      try {
        const [e, b] = await Promise.all([api.escalations(), api.blocked()]);
        if (!live) return;
        setLate(e.late);
        setUnheld(e.counts.unheld);
        setReviewWaiting(e.reviewWaiting ?? []);
        setBlocked(b.unassigned.filter((u) => u.status === 'blocked'));
      } catch {
        // The panel already carries the "feed lost" banner; a stale waiting list should
        // not shout twice about the same outage.
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [show]);

  if (!show || (late.length === 0 && blocked.length === 0 && reviewWaiting.length === 0)) return null;

  const radiologists = panel.filter((p) => p.role === 'radiologist');

  const toggle = (studyId: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(studyId)) next.delete(studyId); else next.add(studyId);
      return next;
    });
  };

  async function bulkAssign() {
    const clinicianUserId = Number(readerId);
    if (picked.size === 0 || !Number.isInteger(clinicianUserId)) return;
    setAssignBusy(true);
    setAssignError(null);
    try {
      const res = await api.bulkAssign([...picked], clinicianUserId);
      setPicked(new Set());
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setAssignError(`${res.assigned} assigned, ${failed.length} not (${failed[0]?.error ?? 'unknown'})`);
      }
    } catch (err) {
      setAssignError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setAssignBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        Waiting
        <span className="sub">
          {late.length > 0 && ` · ${late.length} late`}
          {reviewWaiting.length > 0 && ` · ${reviewWaiting.length} awaiting second name`}
          {blocked.length > 0 && ` · ${blocked.length} cannot route`}
        </span>
      </h2>
      {late.length > 0 && (
        <table>
          <thead>
            <tr><th>Case</th><th>Priority</th><th>Deadline</th><th>Held by</th><th /></tr>
          </thead>
          <tbody>
            {late.map((c) => (
              <tr key={c.clockId} className={c.breached ? 'breached' : undefined}>
                <td>
                  <strong>{c.accession ?? `study ${c.studyId}`}</strong>
                  <div className="sub">{c.tenant} · {c.modality} {c.subSpecialty}</div>
                </td>
                <td><span className={`priority ${c.priority}`}>{c.priority}</span></td>
                <td>
                  {c.breached
                    ? <span className="state red">overdue by {Math.abs(c.minutesToDeadline)} min</span>
                    : <span className={c.minutesToDeadline < 60 ? 'state amber' : 'sub'}>{c.minutesToDeadline} min left</span>}
                  <div className="sub">{c.elapsedPct}% of the window · stage {c.stage}{c.stage > 0 ? '' : ' (nothing fired)'}</div>
                </td>
                <td>{c.holder ? `${c.holder.name} — ${c.holder.state}` : <span className="state red">nobody ({unheld} such)</span>}</td>
                {/* An operator opening a late case is not reading it for the record; they
                    are deciding whether to take it off the routing queue by hand, and they
                    cannot judge that from an accession number. */}
                <td><button onClick={() => onOpen(c.studyId)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {reviewWaiting.length > 0 && (
        <>
          <h3 className="sub">Awaiting second name</h3>
          <table>
            <thead>
              <tr><th>Report</th><th>Author</th><th>Waiting</th><th /></tr>
            </thead>
            <tbody>
              {reviewWaiting.map((r) => (
                <tr key={r.reportId}>
                  <td>
                    <strong>{r.accession ?? `study ${r.studyId}`}</strong>
                    <div className="sub">{r.tenant} · {r.modality} {r.subSpecialty}</div>
                  </td>
                  <td>{r.authorName}</td>
                  <td>{r.waitingMinutes !== null ? `${r.waitingMinutes} min` : '—'}</td>
                  <td><button onClick={() => onOpen(r.studyId)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {blocked.length > 0 && (
        <>
          <h3 className="sub">Cannot route automatically</h3>
          <div className="filters">
            <select value={readerId} onChange={(e) => setReaderId(e.target.value)}>
              <option value="">Assign to…</option>
              {radiologists.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name} ({p.label}, {p.openCases}/{p.maxQueueSize})
                </option>
              ))}
            </select>
            <button className="primary" disabled={assignBusy || picked.size === 0 || !readerId}
              onClick={() => void bulkAssign()}>
              {assignBusy ? 'Assigning…' : `Assign selected (${picked.size})`}
            </button>
            {picked.size > 0 && <button onClick={() => setPicked(new Set())}>Clear</button>}
          </div>
          {assignError && <div className="error">{assignError}</div>}
          {blocked.map((b) => (
            <div className="workcase" key={b.studyId}>
              <input type="checkbox" checked={picked.has(b.studyId)}
                onChange={() => toggle(b.studyId)} />
              <span className={`priority ${b.priority}`}>{b.priority}</span>
              <div className="who">
                <strong>study {b.studyId}</strong>
                <div className="sub">{b.modality} {b.subSpecialty} · waiting {b.waitingMinutes} min · stage {b.escalationStage}</div>
                <div className="sub">
                  nearest: {b.nearestReader ? `${b.nearestReader.name} (${b.nearestReader.missing.join(', ')})` : 'nobody on the panel'}
                  {b.poolWidened && ' · pool widened'}
                </div>
              </div>
              <button onClick={() => onOpen(b.studyId)}>Open</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Row({ row, me }: { row: PanelRow; me: boolean }) {
  const why = row.code === 'idle' || row.code === 'signed_out'
    ? `last signal ${ago(row.sinceSeenSeconds)} ago`
    : row.code === 'at_cap' ? `${row.openCases} of ${row.maxQueueSize} held`
      : `since ${ago(Math.max(0, Math.round(((Date.now() - new Date(row.declaredSince ?? Date.now()).getTime()) / 1000))))}`;

  return (
    <tr className={row.routable ? 'routable' : undefined}>
      <td>
        <span className={`dot ${row.color}`} />
        <strong>{row.name}</strong>{me && <span className="sub"> — you</span>}
        <div className="sub">{row.grade} · {row.registration || 'no registration on file'}</div>
      </td>
      <td>
        <span className={`state ${row.color}`}>{row.label}</span>
        <div className="sub">{why}</div>
      </td>
      <td className={`load ${row.openCases >= row.maxQueueSize ? 'full' : ''}`}>{row.openCases} / {row.maxQueueSize}</td>
      <td className="hide-sm">
        {row.modalityCodes.map((m) => <span className="chip" key={m}>{m}</span>)}
        {row.subspecialtyCodes.slice(0, 4).map((s) => <span className="chip" key={s}>{s}</span>)}
        {row.subspecialtyCodes.length > 4 && <span className="sub">+{row.subspecialtyCodes.length - 4}</span>}
      </td>
      <td className="sub hide-sm">
        {row.onShift
          ? `${row.onShift.kind} until ${new Date(row.onShift.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'no roster window'}
      </td>
    </tr>
  );
}

function TotpSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<{ totpEnabled: boolean; backupCodeCount: number } | null>(null);
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.totpStatus().then((s) => setStatus({ totpEnabled: s.totpEnabled, backupCodeCount: s.backupCodeCount })).catch(() => {});
  }, []);

  const handleSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.totpSetup();
      setSetupData({ secret: data.secret, otpauthUri: data.otpauthUri });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start setup');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.totpVerify(verifyCode);
      setBackupCodes(result.backupCodes);
      setStatus({ totpEnabled: true, backupCodeCount: result.backupCodes.length });
      setSetupData(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(disablePassword);
      setStatus({ totpEnabled: false, backupCodeCount: 0 });
      setDisablePassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to disable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ maxWidth: '500px', maxHeight: '90vh', overflow: 'auto' }}>
        <h2>Two-factor authentication</h2>

        {status?.totpEnabled ? (
          <>
            <p style={{ color: '#28a745', fontWeight: 'bold' }}>✓ Two-factor authentication is enabled</p>
            <p style={{ fontSize: '0.9em', color: '#666' }}>
              Backup codes remaining: {status.backupCodeCount}
            </p>
            <hr />
            <h3>Disable 2FA</h3>
            <input
              type="password"
              placeholder="Enter your password to confirm"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              style={{ width: '100%', marginBottom: '0.5em' }}
            />
            <button onClick={handleDisable} disabled={busy || !disablePassword}>
              {busy ? 'Disabling…' : 'Disable 2FA'}
            </button>
          </>
        ) : setupData ? (
          <>
            <p style={{ fontSize: '0.9em', marginBottom: '1em' }}>
              Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.):
            </p>
            <div style={{ textAlign: 'center', margin: '1em 0' }}>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setupData.otpauthUri)}`}
                alt="QR Code"
                style={{ border: '1px solid #ddd', padding: '10px' }}
              />
            </div>
            <p style={{ fontSize: '0.85em', color: '#666', wordBreak: 'break-all' }}>
              Or enter this secret manually: <code>{setupData.secret}</code>
            </p>
            <hr />
            <p>Enter the 6-digit code from your app to verify:</p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="6-digit code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              style={{ width: '100%', marginBottom: '0.5em' }}
            />
            <button className="primary" onClick={handleVerify} disabled={busy || verifyCode.length !== 6}>
              {busy ? 'Verifying…' : 'Verify and enable'}
            </button>
            <button onClick={() => setSetupData(null)} style={{ marginLeft: '0.5em' }}>Cancel</button>
          </>
        ) : (
          <>
            <p>Two-factor authentication adds an extra layer of security to your account.</p>
            <button className="primary" onClick={handleSetup} disabled={busy}>
              {busy ? 'Loading…' : 'Set up 2FA'}
            </button>
          </>
        )}

        {backupCodes && (
          <div style={{ marginTop: '1em', padding: '1em', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px' }}>
            <h3 style={{ color: '#856404' }}>⚠ Save your backup codes</h3>
            <p style={{ fontSize: '0.9em', color: '#856404' }}>
              Store these codes in a safe place. Each code can only be used once if you lose access to your authenticator app.
            </p>
            <div style={{ fontFamily: 'monospace', fontSize: '0.9em', lineHeight: '1.8' }}>
              {backupCodes.map((code, i) => (
                <div key={i}>{code}</div>
              ))}
            </div>
            <button onClick={() => setBackupCodes(null)} style={{ marginTop: '0.5em' }}>
              I've saved these codes
            </button>
          </div>
        )}

        {error && <p style={{ color: '#dc3545', marginTop: '1em' }}>{error}</p>}

        <button onClick={onClose} style={{ marginTop: '1em' }}>Close</button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [data, setData] = useState<Panel | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [modality, setModality] = useState('');
  const [routableOnly, setRoutableOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openStudy, setOpenStudy] = useState<number | null>(null);
  const [showTotpSettings, setShowTotpSettings] = useState(false);
  const [nav, setNav] = useState('dashboard');

  const isReader = session !== null && READER_ROLES.includes(session.user.role);
  const isDesk = session !== null && DESK_ROLES.includes(session.user.role);
  const isOperator = session !== null && OPERATOR_ROLES.includes(session.user.role);
  const isOwner = session !== null && session.user.role === 'owner';

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null)).finally(() => setBooting(false));
  }, []);

  const beat = useCallback(async () => {
    try {
      setMine(await api.heartbeat());
      setFeedError(null);
    } catch (err) {
      // A 401 here means the twelve-hour session aged out while the tab stayed
      // open. Showing a stale green dot after that would be the exact lie this
      // board exists to prevent, so the whole view goes back to the login form.
      if (err instanceof ApiError && err.status === 401) setSession(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setData(await api.panel());
      setFeedError(null);
    } catch (err) {
      setFeedError(err instanceof ApiError ? `${err.status} ${err.code ?? ''}`.trim() : 'server unreachable');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh();
    if (isReader) void beat();
    const panelTimer = setInterval(() => void refresh(), REFRESH_MS);
    const beatTimer = isReader ? setInterval(() => void beat(), HEARTBEAT_MS) : undefined;
    const onVisible = () => { if (document.visibilityState === 'visible' && isReader) void beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(panelTimer);
      if (beatTimer) clearInterval(beatTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, isReader, refresh, beat]);

  async function declare(state: string) {
    setBusy(true);
    try {
      await api.declare(state);
      await beat();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => data?.panel ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (routableOnly && !row.routable) return false;
      if (modality && !row.modalityCodes.includes(modality)) return false;
      if (q && !(row.name.toLowerCase().includes(q) || row.subspecialtyCodes.some((c) => c.includes(q)))) return false;
      return true;
    });
  }, [rows, query, modality, routableOnly]);
  const modalities = useMemo(() => [...new Set(rows.flatMap((r) => r.modalityCodes))].sort(), [rows]);

  if (booting) return <main className="card">Loading…</main>;
  if (!session) return <Login onSignedIn={setSession} />;
  // The viewer takes the whole window. A reader comparing two slices should not be doing
  // it in a panel the size of a sidebar, and the board behind it is not the thing on
  // screen while a case is open. The heartbeat keeps running underneath.
  if (openStudy !== null) {
    return (
      <Viewer
        studyId={openStudy}
        onBack={() => setOpenStudy(null)}
        onChanged={() => { void refresh(); }}
      />
    );
  }

  const counts = data?.counts ?? { green: 0, amber: 0, red: 0 };

  // Build navigation items based on role
  type NavItem = { id: string; label: string; badge?: number };
  const navItems: NavItem[] = [];
  navItems.push({ id: 'dashboard', label: 'Dashboard' });
  if (isReader) {
    navItems.push({ id: 'worklist', label: 'My Cases' });
    navItems.push({ id: 'reports', label: 'Reports' });
  }
  if (isDesk) {
    navItems.push({ id: 'delivery', label: 'Delivery' });
    navItems.push({ id: 'criticals', label: 'Criticals' });
    navItems.push({ id: 'notices', label: 'Notices' });
  }
  navItems.push({ id: 'search', label: 'Search' });
  if (isOperator) {
    navItems.push({ id: 'operations', label: 'Operations' });
    navItems.push({ id: 'admin', label: 'Admin' });
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>telrad</h1>
          <div className="user-info">
            {session.user.name ?? 'User'} · {session.user.role}
          </div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <div
              key={item.id}
              className={`sidebar-nav-item ${nav === item.id ? 'active' : ''}`}
              onClick={() => setNav(item.id)}
            >
              {item.label}
              {item.badge !== undefined && item.badge > 0 && (
                <span className="badge">{item.badge}</span>
              )}
            </div>
          ))}
        </nav>
        <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 'auto' }}>
          {isOwner && (
            <div
              className="sidebar-nav-item"
              onClick={() => setShowTotpSettings(true)}
              style={{ padding: '8px 0', border: 'none' }}
            >
              Security Settings
            </div>
          )}
          <div
            className="sidebar-nav-item"
            onClick={async () => {
              try { await api.logout(); } catch { /* clear local state anyway */ }
              setSession(null);
            }}
            style={{ padding: '8px 0', border: 'none' }}
          >
            Sign out
          </div>
        </div>
      </aside>

      <div className="main-content">
        <header className="bar">
          <h1>{navItems.find((n) => n.id === nav)?.label ?? 'Dashboard'}</h1>
          <span className="when">
            {data ? `updated ${new Date(data.generatedAt).toLocaleTimeString()}` : 'no data yet'}
            {feedError && ' · feed lost'}
          </span>
          <div className="counts">
            <span className="count green">{counts.green} routable</span>
            <span className="count amber">{counts.amber} not routable</span>
            <span className="count red">{counts.red} off</span>
          </div>
        </header>

        {showTotpSettings && <TotpSettings onClose={() => setShowTotpSettings(false)} />}

        <main>
          {feedError && (
            <div className="banner">
              The board cannot reach the server ({feedError}). Colours below are from the last
              successful read and may already be wrong.
            </div>
          )}

          {/* Dashboard: panel overview + presence */}
          {nav === 'dashboard' && (
            <>
              {isReader && mine && (
                <div className="card me">
                  <span className={`dot ${mine.color}`} />
                  <span className="who">{session.user.name ?? 'You'} — {mine.label}</span>
                  <span className="why">
                    {mine.openCases} of {mine.maxQueueSize} slots held.
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button disabled={busy} onClick={() => void declare('receiving')}>Take cases</button>
                    <button disabled={busy} onClick={() => void declare('paused')}>Pause</button>
                    <button disabled={busy} onClick={() => void declare('away')}>Step away</button>
                    <button disabled={busy} onClick={() => void declare('offline')}>Sign off panel</button>
                  </span>
                </div>
              )}

              {counts.green === 0 && !feedError && (
                <div className="banner">Nobody is routable right now. Anything waiting will wait.</div>
              )}

              <div className="card">
                <h2>Reader panel</h2>
                <div className="filters">
                  <input type="search" placeholder="name or sub-specialty" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <select value={modality} onChange={(e) => setModality(e.target.value)}>
                    <option value="">Any modality</option>
                    {modalities.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <label>
                    <input type="checkbox" checked={routableOnly} onChange={(e) => setRoutableOnly(e.target.checked)} />
                    routable only
                  </label>
                  <button onClick={() => void refresh()}>Refresh</button>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>Reader</th><th>Status</th><th>Queue</th>
                      <th className="hide-sm">Reads</th><th className="hide-sm">Roster</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => <Row key={row.userId} row={row} me={row.userId === session.user.id} />)}
                    {filtered.length === 0 && (
                      <tr><td colSpan={5} className="sub">
                        {rows.length === 0
                          ? 'No clinician has a profile yet. A user needs a clinician profile to appear here.'
                          : 'Nobody matches this filter.'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Worklist: reader's cases */}
          {nav === 'worklist' && isReader && (
            <>
              <Worklist onChanged={() => { void refresh(); }} onOpen={setOpenStudy} />
              <ReviewQueue show onOpen={setOpenStudy} />
              <MyReports show onOpen={setOpenStudy} />
            </>
          )}

          {/* Reports: review queue + my reports (for readers who land here) */}
          {nav === 'reports' && isReader && (
            <>
              <ReviewQueue show onOpen={setOpenStudy} />
              <MyReports show onOpen={setOpenStudy} />
            </>
          )}

          {/* Delivery desk */}
          {nav === 'delivery' && isDesk && (
            <AwaitingDelivery show canOpen={isOperator} onOpen={setOpenStudy} />
          )}

          {nav === 'criticals' && isDesk && (
            <CriticalBoard show canOpen={isOperator} onOpen={setOpenStudy} />
          )}

          {nav === 'notices' && isDesk && (
            <NoticeQueue show canOpen={isOperator} onOpen={setOpenStudy} />
          )}

          {/* Search: available to everyone */}
          {nav === 'search' && (
            <SearchReports tenantId={session.user.tenantId} onOpen={setOpenStudy} />
          )}

          {/* Operations: operator's working board */}
          {nav === 'operations' && isOperator && (
            <>
              <Waiting show panel={rows} onOpen={setOpenStudy} />
              <Orphans show onOpen={setOpenStudy} />
              <Performance show />
              <SlaTargets show tenantId={session.user.tenantId} />
              <FilmExports show canOpen onOpen={setOpenStudy} />
            </>
          )}

          {/* Admin: configuration */}
          {nav === 'admin' && isOperator && (
            <>
              <Users show />
              <Sites show />
              <Tariffs show tenantId={session.user.tenantId} />
              <Retention show canEdit={session.user.role === 'owner'} />
              <AuditBoard show />
              {session.user.tenantId !== null && <Billing tenantId={session.user.tenantId} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
