import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CriticalCondition, type CriticalItem, type ReportView } from './api';

const CHANNELS: { code: string; label: string; needsNumber: boolean }[] = [
  { code: 'phone', label: 'Phone — spoke to them', needsNumber: true },
  { code: 'sms', label: 'SMS', needsNumber: true },
  { code: 'whatsapp', label: 'WhatsApp', needsNumber: true },
  { code: 'email', label: 'Email', needsNumber: false },
  { code: 'portal', label: 'Left in the portal', needsNumber: false },
];

const TONE: Record<CriticalItem['state'], string> = {
  acknowledged: 'green', waiting: 'amber', breached: 'red',
};

/**
 * How long until the acknowledgement is due, in the words a person acts on.
 *
 * Negative minutes are printed as overdue rather than clamped to zero: a board that shows
 * "7 minutes overdue" is a desk that knows how late it is, and one that shows "0" has run out
 * of reasons to pick up the phone.
 */
export function countdown(item: CriticalItem): string {
  if (item.acknowledgedAt !== null) {
    const when = new Date(item.acknowledgedAt);
    return `answered by ${item.acknowledgedByName ?? 'a named clinician'} at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      + (item.late ? ' — after the window' : '');
  }
  const left = item.minutesLeft ?? 0;
  return left >= 0
    ? `${left} min before the answer is late`
    : `${-left} min overdue, and nobody has answered`;
}

/** The line a board prints when it has no room for the form. */
export function criticalSummary(item: CriticalItem): string {
  const who = item.receiverName ?? 'nobody named';
  return `${item.text} · ${item.channel ?? 'no channel'} · told ${who} · ${countdown(item)}`;
}

/**
 * The critical-finding loop on one report.
 *
 * Two different people act here, and the panel keeps them apart. The reader who found the
 * thing declares it and names who they told; the desk records the answer when somebody says
 * they heard it. Neither can do the other's job, which is the whole design: a finding is
 * closed when the referring side says it received it, not when the reporting side says it
 * tried.
 */
export function CriticalPanel({ report, onChanged }: {
  report: ReportView;
  onChanged: () => void;
}) {
  const [conditions, setConditions] = useState<CriticalCondition[]>([]);
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState('');
  const [channel, setChannel] = useState('phone');
  const [receiverName, setReceiverName] = useState('');
  const [receiverRole, setReceiverRole] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [detail, setDetail] = useState('');
  const [ackFor, setAckFor] = useState<number | null>(null);
  const [ackName, setAckName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The catalogue is fetched once, not on every render of every report panel: it changes when
  // the code is redeployed and nothing else.
  const fetched = useRef(false);

  const load = useCallback(async () => {
    if (fetched.current) return;
    fetched.current = true;
    try {
      setConditions((await api.criticalCatalogue()).conditions);
    } catch {
      // An unreadable list is not a reason to hide the loops that already exist; the declare
      // button explains itself when pressed.
      fetched.current = false;
    }
  }, []);

  useEffect(() => { if (report.can.declareCritical) void load(); }, [load, report.can.declareCritical]);

  const items = report.criticals;
  const openCount = items.filter((c) => c.acknowledgedAt === null).length;

  async function declare() {
    setBusy(true);
    setError(null);
    try {
      await api.declareCritical({
        studyId: report.studyId,
        condition,
        channel,
        receiverName: receiverName.trim(),
        receiverRole: receiverRole.trim() === '' ? null : receiverRole.trim(),
        receiverPhone: receiverPhone.trim() === '' ? null : receiverPhone.trim(),
        detail: detail.trim() === '' ? null : detail.trim(),
      });
      setCondition(''); setReceiverName(''); setReceiverRole(''); setReceiverPhone(''); setDetail('');
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api.ackCritical(id, ackName);
      setAckFor(null); setAckName('');
      onChanged();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  const needsNumber = CHANNELS.find((c) => c.code === channel)?.needsNumber ?? false;

  return (
    <div className="criticals">
      <h4>
        Critical findings
        {items.length > 0 && (
          <span className={`state ${openCount > 0 ? 'red' : 'green'}`}>
            {' '}{openCount === 0 ? 'all answered' : `${openCount} still unanswered`}
          </span>
        )}
      </h4>
      {error && <div className="banner">{error}</div>}

      {items.length === 0 ? (
        <p className="sub">
          Nothing declared. A finding is declared here by the reader in words — never inferred
          from the text of the report, because a wrong alarm at 2 a.m. teaches the clinic to
          ignore the next one.
        </p>
      ) : (
        <ul className="criticallist">
          {items.map((c) => (
            <li key={c.id} className={`critical ${TONE[c.state]}`}>
              <p>
                <strong>{c.text}</strong>
                {' '}
                <span className={`state ${TONE[c.state]}`}>{c.state}</span>
                <span className="sub"> · {c.channel ?? 'no channel'} · told {c.receiverName ?? 'nobody named'}</span>
              </p>
              <p className="sub">{countdown(c)}</p>
              {c.mayAcknowledge && c.acknowledgedAt === null && (
                ackFor === c.id ? (
                  <div className="acts">
                    <input
                      placeholder="who said they heard it"
                      value={ackName}
                      onChange={(e) => setAckName(e.target.value)}
                    />
                    <button
                      className="primary"
                      disabled={busy || ackName.trim() === ''}
                      onClick={() => void acknowledge(c.id)}
                    >
                      Record the answer
                    </button>
                    <button disabled={busy} onClick={() => setAckFor(null)}>cancel</button>
                  </div>
                ) : (
                  <button disabled={busy} onClick={() => { setAckFor(c.id); setAckName(c.receiverName ?? ''); }}>
                    Record acknowledgement
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {openCount > 0 && (
        // The consequence, stated where the work is. A desk that does not know the document is
        // held would blame the delivery button rather than the missing phone call — and a
        // report that has already gone out must not be described as still being held by the
        // same sentence, because then nothing about it is believable.
        <p className="note">
          {report.state === 'signed' || report.state === 'verified'
            ? 'While any finding here is unanswered, this report cannot be released to the clinic.'
            : 'These findings were declared after the document went out. The answer is still owed, and the board will say so when the window runs out.'}
        </p>
      )}

      {report.can.declareCritical && (
        open ? (
          <div className="declare">
            <label className="field">
              <span>Finding</span>
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                <option value="">choose from the list</option>
                {conditions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label} — answer within {c.slaMinutes} min
                  </option>
                ))}
              </select>
            </label>
            {condition === 'other' && (
              <label className="field">
                <span>What it is, in your words</span>
                <textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span>How you told them</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </label>
            <div className="row">
              <input placeholder="who you told (name)" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} />
              <input placeholder="their role" value={receiverRole} onChange={(e) => setReceiverRole(e.target.value)} />
              {needsNumber && (
                <input placeholder="the number you rang" value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} />
              )}
            </div>
            <div className="acts">
              <button
                className="primary"
                disabled={busy || condition === '' || receiverName.trim() === ''}
                onClick={() => void declare()}
              >
                Declare it
              </button>
              <button disabled={busy} onClick={() => setOpen(false)}>cancel</button>
              <span className="sub">this holds the report until somebody answers</span>
            </div>
          </div>
        ) : (
          <button disabled={busy} onClick={() => { setOpen(true); void load(); }}>
            Declare a critical finding
          </button>
        )
      )}
    </div>
  );
}

function explainError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'cannot reach the server';
}

// The countdown is computed by the server on every read, so a board that has not asked in
// five minutes is showing minutes nobody has left. Long enough that a desk notices the number
// moving, short enough not to be a second clock on a laptop in a clinic.
const BOARD_MS = 15_000;

/**
 * Every critical loop still open, for the accounts that have to chase it.
 *
 * This is the board that did not exist when the finding was only a sentence in a report: a
 * reader phones, the phone call is not written down, and the report goes to the clinic while
 * the patient is still waiting for somebody to act. Open loops are listed oldest first,
 * answered or not, and the desk can close one here without opening the images.
 */
export function CriticalBoard({ show, canOpen, onOpen }: {
  show: boolean;
  canOpen: boolean;
  onOpen: (studyId: number) => void;
}) {
  const [items, setItems] = useState<CriticalItem[]>([]);
  const [ackFor, setAckFor] = useState<number | null>(null);
  const [ackName, setAckName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.criticals()).criticals);
    } catch {
      // The board keeps its last list on a dropped feed; the header says when it was read.
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), BOARD_MS);
    return () => clearInterval(timer);
  }, [show, load]);

  async function acknowledge(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api.ackCritical(id, ackName);
      setAckFor(null); setAckName('');
      await load();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!show || items.length === 0) return null;
  const breached = items.filter((c) => c.state === 'breached').length;

  return (
    <div className="card">
      <h2>
        Critical loops
        <span className={`count ${breached > 0 ? 'amber' : 'green'}`}>
          {items.length} open{breached > 0 ? ` · ${breached} past their window` : ''}
        </span>
      </h2>
      {error && <div className="error">{error}</div>}
      {items.map((c) => (
        <div className="workcase" key={c.id}>
          <div className="who">
            <strong>{c.text}</strong>
            <div className="sub">
              {c.accession ?? `study ${c.studyId}`} · {c.patientName ?? 'name not carried'}
              {' · told '}{c.receiverName ?? 'nobody named'}
              {c.receiverRole ? ` (${c.receiverRole})` : ''} by {c.channel ?? 'no channel'}
            </div>
            <div className="sub">
              <span className={`state ${TONE[c.state]}`}>{c.state}</span> · {countdown(c)}
              {' · '}
              declared by {c.detectedByName ?? 'a reader'}
            </div>
          </div>
          {c.mayAcknowledge && (
            ackFor === c.id ? (
              <div className="acts">
                <input
                  placeholder="who said they heard it"
                  value={ackName}
                  onChange={(e) => setAckName(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={busy || ackName.trim() === ''}
                  onClick={() => void acknowledge(c.id)}
                >
                  Record
                </button>
                <button disabled={busy} onClick={() => setAckFor(null)}>cancel</button>
              </div>
            ) : (
              <button disabled={busy} onClick={() => { setAckFor(c.id); setAckName(c.receiverName ?? ''); }}>
                Record acknowledgement
              </button>
            )
          )}
          {canOpen && <button onClick={() => onOpen(c.studyId)}>Open</button>}
        </div>
      ))}
    </div>
  );
}
