import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Panel, type PanelRow, type PresenceColor, type Session } from './api';

const HEARTBEAT_MS = 20_000;
const REFRESH_MS = 5_000;
const READER_ROLES = ['radiologist', 'reviewer'];

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form className="login card" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        onSignedIn(await api.login(email, password));
      } catch (err) {
        setError(err instanceof ApiError && err.status === 401 ? 'Wrong email or password' : 'Cannot reach the server');
      } finally {
        setBusy(false);
      }
    }}>
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

  const isReader = session !== null && READER_ROLES.includes(session.user.role);

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

  const counts = data?.counts ?? { green: 0, amber: 0, red: 0 };

  return (
    <>
      <header className="bar">
        <h1>On panel</h1>
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

      <main>
        {feedError && (
          <div className="banner">
            The board cannot reach the server ({feedError}). Colours below are from the last
            successful read and may already be wrong.
          </div>
        )}

        {isReader && mine && (
          <div className="card me">
            <span className={`dot ${mine.color}`} />
            <span className="who">{session.user.name ?? 'You'} — {mine.label}</span>
            <span className="why">
              {mine.openCases} of {mine.maxQueueSize} slots held. This page keeps you on the panel
              while it is open; closing it takes you off within about ninety seconds.
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
      </main>
    </>
  );
}
