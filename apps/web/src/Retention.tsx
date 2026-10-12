import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type RetentionRow } from './api';

// Image retention per center. The card is one contract sentence: pixels age out,
// records do not. An empty box means forever, because "no policy" must look
// different from "7 days" at a glance — it is the default every center starts on.
export function Retention({ show, canEdit }: { show: boolean; canEdit: boolean }) {
  const [rows, setRows] = useState<RetentionRow[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.tenantRetention()).retention);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show) return null;

  const save = async (row: RetentionRow) => {
    setError(null);
    setNotice(null);
    const text = (edits[row.tenantId] ?? '').trim();
    let days: number | null = null;
    if (text !== '') {
      days = Number(text);
      if (!Number.isInteger(days) || days < 1) {
        setError('retention must be a whole number of days, or empty to keep images forever');
        return;
      }
    }
    try {
      await api.setTenantRetention(row.tenantId, days);
      setNotice(days === null
        ? `${row.code}: images kept forever`
        : `${row.code}: pixels deleted after ${days} days`);
      setEdits((e) => ({ ...e, [row.tenantId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  };

  return (
    <div className="card">
      <h2>
        Image retention
        <span className="sub"> · per center; pixels are deleted, reports and billing always stay</span>
      </h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="sub">{notice}</div>}
      {rows.length === 0 && <div className="sub">No centers yet.</div>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Center</th><th>Policy</th>{canEdit && <th>Days</th>}<th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.tenantId}>
                <td><span className="chip">{row.code}</span> {row.legalName}</td>
                <td className="sub">
                  {row.retentionDays === null
                    ? 'kept forever'
                    : `pixels deleted after ${row.retentionDays} days`}
                </td>
                {canEdit && (
                  <td>
                    <input placeholder="days (empty = forever)" type="number" min={1}
                      value={edits[row.tenantId] ?? ''}
                      onChange={(e) => setEdits((m) => ({ ...m, [row.tenantId]: e.target.value }))}
                      style={{ width: 150 }} />
                  </td>
                )}
                <td>
                  {canEdit
                    ? <button className="primary" onClick={() => void save(row)}>Save</button>
                    : <span className="sub">owner only</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="sub">
        Empty = keep images forever. A pinned study is never swept. The nightly sweep deletes
        pixels only — the report, the billable events and the audit chain stay.
      </div>
    </div>
  );
}
