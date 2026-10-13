import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type OrphanStudy } from './api';

export function Orphans({ show, onOpen }: { show: boolean; onOpen: (studyId: number) => void }) {
  const [orphans, setOrphans] = useState<OrphanStudy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.orphans();
      setOrphans(res.orphans);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot load orphans');
    }
  }, []);

  useEffect(() => {
    if (show) void load();
  }, [show, load]);

  const link = async (studyId: number, orderId: number) => {
    setBusy(studyId);
    setError(null);
    try {
      await api.linkStudy(studyId, orderId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot link study');
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (studyId: number) => {
    setBusy(studyId);
    setError(null);
    try {
      await api.unlinkStudy(studyId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot unlink study');
    } finally {
      setBusy(null);
    }
  };

  if (!show) return null;

  return (
    <div className="card">
      <h2>
        Orphan studies
        <span className="sub"> · {orphans.length} unlinked</span>
      </h2>
      {error && <div className="error">{error}</div>}
      {orphans.length === 0 && !error && (
        <div className="sub">All studies are linked to orders.</div>
      )}
      {orphans.map((o) => (
        <div className="workcase" key={o.studyId}>
          <div className="who">
            <strong>Study {o.studyId}</strong>
            <div className="sub">
              {o.accession ?? 'no accession'} · {o.modality ?? '?'}
              {o.patientName && ` · ${o.patientName}`}
              {o.tenantCode && ` · ${o.tenantCode}`}
            </div>
            <div className="sub">
              received {new Date(o.receivedAt).toLocaleDateString()}
              {o.studyDate && ` · study date ${o.studyDate}`}
            </div>
            {o.candidates.length > 0 && (
              <div className="sub" style={{ marginTop: '6px' }}>
                <strong>{o.candidates.length} candidate order{o.candidates.length > 1 ? 's' : ''}:</strong>
                {o.candidates.map((c) => (
                  <div key={c.orderId} style={{ marginLeft: '12px', marginTop: '4px' }}>
                    Order #{c.orderId}: {c.patientName ?? 'unknown patient'} · {c.modalityCode ?? '?'} · {c.priority ?? 'routine'}
                    <button
                      style={{ marginLeft: '8px' }}
                      disabled={busy === o.studyId}
                      onClick={() => void link(o.studyId, c.orderId)}
                    >
                      Link
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => onOpen(o.studyId)}>Open</button>
          <button disabled={busy === o.studyId} onClick={() => void unlink(o.studyId)}>
            {busy === o.studyId ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
      ))}
    </div>
  );
}
