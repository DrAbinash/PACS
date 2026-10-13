import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SearchResultItem } from './api';

export function SearchReports({ tenantId, onOpen }: { tenantId: number | null; onOpen: (studyId: number) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.searchReports(query.trim(), tenantId ?? undefined);
      setResults(res.results);
      setSearched(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'search failed');
    } finally {
      setBusy(false);
    }
  }, [query, tenantId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length >= 3) void handleSearch();
    }, 500);
    return () => clearTimeout(timer);
  }, [query, handleSearch]);

  return (
    <div className="card">
      <h2>Search reports</h2>
      <div className="filters">
        <input
          type="search"
          placeholder="search by patient name, accession, or findings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: '1 1 300px' }}
        />
        {busy && <span className="sub">searching…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {searched && results.length === 0 && !error && (
        <div className="sub">No reports found.</div>
      )}
      {results.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Accession</th>
              <th>Patient</th>
              <th>Modality</th>
              <th>Author</th>
              <th>Signed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.reportId}>
                <td>
                  <strong>{r.accession ?? `study ${r.studyId}`}</strong>
                  <div className="sub">v{r.version} · {r.state}{r.tenantCode ? ` · ${r.tenantCode}` : ''}</div>
                </td>
                <td>{r.patientName ?? '—'}</td>
                <td>{r.modality ?? '—'}</td>
                <td>{r.authorName}</td>
                <td>{r.signedAt ? new Date(r.signedAt).toLocaleDateString() : '—'}</td>
                <td>
                  <button onClick={() => onOpen(r.studyId)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
