import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FilmExport } from './api';

// Film exports are a till action, not a settings screen: the desk records that a disc
// left the building, and the money joins the next invoice draft on its own. The card
// shows the recent takings so a duplicate entry can be caught while the patient is
// still at the counter, which is the only time catching one is cheap.
const MEDIA = ['cd', 'dvd', 'usb', 'film_print', 'cloud_link'] as const;

function rupees(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
}

export function FilmExports({ show, canOpen, onOpen }: {
  show: boolean;
  canOpen: boolean;
  onOpen: (studyId: number) => void;
}) {
  const [rows, setRows] = useState<FilmExport[]>([]);
  const [studyId, setStudyId] = useState('');
  const [medium, setMedium] = useState<(typeof MEDIA)[number]>('cd');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.filmExports()).exports);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show) return null;

  const create = async () => {
    setError(null);
    setNotice(null);
    const sid = Number(studyId);
    const qty = Number(quantity);
    if (!Number.isInteger(sid) || sid < 1) {
      setError('a study id is required');
      return;
    }
    if (!Number.isInteger(qty) || qty < 1) {
      setError('quantity must be at least 1');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createFilmExport(sid, medium, qty);
      setNotice(`recorded: ${medium} ×${qty} — ${rupees(res.totalPaise)} on the next invoice draft`);
      setStudyId('');
      setQuantity('1');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        Film exports
        <span className="sub"> · each disc or print is one product line on the next invoice</span>
      </h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="sub">{notice}</div>}
      <div className="filters">
        <input placeholder="study id" type="number" min={1} value={studyId}
          onChange={(e) => setStudyId(e.target.value)} style={{ width: 100 }} />
        <select value={medium} onChange={(e) => setMedium(e.target.value as typeof medium)}>
          {MEDIA.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
        </select>
        <input placeholder="qty" type="number" min={1} max={100} value={quantity}
          onChange={(e) => setQuantity(e.target.value)} style={{ width: 70 }} />
        <button className="primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Recording…' : 'Record export'}
        </button>
      </div>
      {rows.length === 0 && <div className="sub">Nothing exported yet.</div>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Study</th><th>Patient</th><th>Medium</th><th>Qty</th><th>Amount</th><th>By</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.studyId}</strong><div className="sub">{r.studyDescription ?? ''}</div></td>
                <td>{r.patientName ?? '—'}</td>
                <td><span className="chip">{r.medium.replace('_', ' ')}</span></td>
                <td>{r.quantity}</td>
                <td>{rupees(r.totalPaise)}</td>
                <td className="sub">{r.requestedByName}<div className="sub">{new Date(r.exportedAt).toLocaleString()}</div></td>
                {canOpen && <td><button onClick={() => onOpen(r.studyId)}>Open</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
