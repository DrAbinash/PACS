import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ReaderPerf } from './api';

// Seconds as the desk reads them: a turn-around number nobody parses in their head is a
// number nobody uses, so the table says "2m 30s" rather than a bare epoch count.
function span(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function Performance({ show }: { show: boolean }) {
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [readers, setReaders] = useState<ReaderPerf[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: { from: string; to: string }) => {
    try {
      const feed = await api.performance(
        new Date(`${range.from}T00:00:00`).toISOString(),
        new Date(`${range.to}T23:59:59`).toISOString());
      setReaders(feed.readers);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load(applied ?? { from, to });
  }, [show, load, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null;

  return (
    <div className="card">
      <h2>
        Reader performance
        <span className="sub"> · who accepted, who completed, how long each read took</span>
      </h2>
      <div className="filters">
        <label>from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={() => setApplied({ from, to })}>Apply</button>
      </div>
      {error && <div className="error">{error}</div>}
      {readers.length === 0 && !error && <div className="sub">No radiologists on record for this window.</div>}
      {readers.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Reader</th><th>Offered</th><th>Accepted</th><th>Declined</th>
              <th>Accept rate</th><th>Completed</th>
              <th className="hide-sm">Accept in</th><th className="hide-sm">Read in</th>
              <th className="hide-sm">Studies/day</th>
            </tr>
          </thead>
          <tbody>
            {readers.map((r) => (
              <tr key={r.userId}>
                <td><strong>{r.name}</strong></td>
                <td>{r.offered}</td>
                <td>{r.accepted}</td>
                <td>{r.declined}</td>
                <td>
                  <span className={`state ${r.acceptanceRate >= 70 ? 'green' : r.acceptanceRate >= 40 ? 'amber' : 'red'}`}>
                    {r.acceptanceRate}%
                  </span>
                </td>
                <td>{r.completed}</td>
                <td className="hide-sm">{span(r.avgAcceptSeconds)}</td>
                <td className="hide-sm">{span(r.avgReadSeconds)}</td>
                <td className="hide-sm">{r.studiesPerDay.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
