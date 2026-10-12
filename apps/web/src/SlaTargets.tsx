import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SlaTarget } from './api';

// Turn-around targets the desk sets per modality and priority. Everything else in the
// platform computes deadlines from these rows, so the card states plainly that a change
// here moves real cases — it is a routing setting wearing a settings-page dress.
const PRIORITIES = ['stat', 'urgent', 'routine'] as const;

export function SlaTargets({ show, tenantId }: { show: boolean; tenantId: number | null }) {
  const [targets, setTargets] = useState<SlaTarget[]>([]);
  const [modality, setModality] = useState('');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('urgent');
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTargets((await api.slaTargets()).targets);
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

  const create = async () => {
    setError(null);
    setNotice(null);
    const slaMinutes = Number(minutes);
    if (!modality.trim() || !Number.isInteger(slaMinutes) || slaMinutes < 1) {
      setError('modality and a positive minute count are both required');
      return;
    }
    try {
      await api.createSlaTarget({
        modalityCode: modality.trim().toUpperCase(),
        priority,
        slaMinutes,
        tenantId: tenantId ?? undefined,
      });
      setModality('');
      setMinutes('');
      setNotice('target set — new cases route against it from the next sweep');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  };

  const retire = async (t: SlaTarget) => {
    setError(null);
    try {
      await api.deactivateSlaTarget(t.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reach the server');
    }
  };

  return (
    <div className="card">
      <h2>
        Turn-around targets
        <span className="sub"> · per modality and priority; changing one moves live deadlines</span>
      </h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="sub">{notice}</div>}
      {tenantId === null
        ? <div className="sub">SLA targets belong to a center — this login has no center, so there is nothing to set. Sign in as a center operator.</div>
        : (
      <div className="filters">
        <input placeholder="modality (e.g. MR, CT)" value={modality} maxLength={4}
          onChange={(e) => setModality(e.target.value)} style={{ width: 110 }} />
        <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input placeholder="minutes" type="number" min={1} max={10080} value={minutes}
          onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
        <button className="primary" onClick={() => void create()}>Set target</button>
      </div>
      )}
      {targets.length === 0 && <div className="sub">No custom targets — deadlines fall back to the sub-specialty defaults.</div>}
      {targets.length > 0 && (
        <table>
          <thead>
            <tr><th>Modality</th><th>Priority</th><th>Target</th><th>Since</th><th /></tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id}>
                <td><span className="chip">{t.modalityCode}</span></td>
                <td><span className={`priority ${t.priority}`}>{t.priority}</span></td>
                <td><strong>{t.slaMinutes} min</strong></td>
                <td className="sub">{new Date(t.effectiveFrom).toLocaleDateString()}</td>
                <td><button onClick={() => void retire(t)}>Retire</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
