import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AuditEntry } from './api';

// The audit chain is the record a regulator reads, so the card prints the hash columns
// rather than hiding them: a row whose prevHash does not name the row above it is a
// question someone would have to answer in writing, and this screen is where the desk
// would first see it. Export is a link, not a fetch, so the browser downloads the file
// with its Content-Disposition intact.
export function AuditBoard({ show }: { show: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await api.auditLatest()).entries);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [show, load]);

  if (!show) return null;

  return (
    <div className="card">
      <h2>
        Audit trail
        <span className="sub"> · latest {entries.length} entries, hash-chained</span>
        <span className="acts" style={{ marginLeft: 'auto' }}>
          <a className="link" href={api.auditExportHref('csv')}>Export CSV</a>
          <a className="link" href={api.auditExportHref('json')}>Export JSON</a>
        </span>
      </h2>
      {error && <div className="error">{error}</div>}
      {entries.length === 0 && !error && <div className="sub">Nothing recorded yet.</div>}
      {entries.length > 0 && (
        <table>
          <thead>
            <tr><th>When</th><th>Action</th><th>Entity</th><th className="hide-sm">Actor</th><th className="hide-sm">Chain</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="sub">{new Date(e.occurredAt).toLocaleString()}</td>
                <td><strong>{e.action}</strong></td>
                <td className="sub">{e.entity} {e.entityId}</td>
                <td className="hide-sm sub">{e.actorUserId ?? '—'}</td>
                <td className="hide-sm sub" title={`row ${e.rowHash}`}>{e.prevHash ? `→ ${e.prevHash.slice(0, 8)}` : 'genesis'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
