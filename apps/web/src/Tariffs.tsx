import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Tariff } from './api';

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

export function Tariffs({ show, tenantId }: { show: boolean; tenantId: number | null }) {
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newModality, setNewModality] = useState('');
  const [newNight, setNewNight] = useState('');

  const load = useCallback(async () => {
    if (tenantId === null) return;
    try {
      const res = await api.tariffs(tenantId);
      setTariffs(res.tariffs);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot load tariffs');
    }
  }, [tenantId]);

  useEffect(() => {
    if (show) void load();
  }, [show, load]);

  const create = async () => {
    if (!newCode.trim() || !newLabel.trim() || !newPrice || tenantId === null) return;
    setBusy(-1);
    setError(null);
    try {
      await api.createTariff({
        tenantId,
        code: newCode.trim(),
        label: newLabel.trim(),
        unitPaise: Math.round(Number(newPrice) * 100),
        modalityCode: newModality.trim() || undefined,
        nightMultiplier: newNight.trim() ? Number(newNight) : undefined,
      });
      setNewCode('');
      setNewLabel('');
      setNewPrice('');
      setNewModality('');
      setNewNight('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot create tariff');
    } finally {
      setBusy(null);
    }
  };

  const activate = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await api.activateTariff(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot activate tariff');
    } finally {
      setBusy(null);
    }
  };

  const retire = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await api.retireTariff(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot retire tariff');
    } finally {
      setBusy(null);
    }
  };

  if (!show) return null;

  const active = tariffs.filter((t) => t.status === 'active');
  const retired = tariffs.filter((t) => t.status === 'retired');

  return (
    <div className="card">
      <h2>Tariffs</h2>
      {error && <div className="error">{error}</div>}

      <div className="filters">
        <input placeholder="code (e.g. MRI-BRAIN)" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
        <input placeholder="label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        <input type="number" min="0" step="1" placeholder="price in ₹" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} style={{ width: 100 }} />
        <input placeholder="modality (optional)" value={newModality} onChange={(e) => setNewModality(e.target.value)} style={{ width: 100 }} />
        <input type="number" min="1" step="0.1" placeholder="night multiplier" value={newNight} onChange={(e) => setNewNight(e.target.value)} style={{ width: 120 }} />
        <button className="primary" disabled={busy !== null || !newCode.trim() || !newLabel.trim() || !newPrice} onClick={() => void create()}>
          {busy === -1 ? 'Creating…' : 'Add tariff'}
        </button>
      </div>

      {active.length === 0 && retired.length === 0 && !error && (
        <div className="sub">No tariffs defined yet.</div>
      )}

      {active.length > 0 && (
        <>
          <h3 className="sub">Active</h3>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Price</th>
                <th>Modality</th>
                <th>Night</th>
                <th>Effective</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.code}</strong></td>
                  <td>{t.label}</td>
                  <td>{t.unitRupees}</td>
                  <td>{t.modalityCode ?? '—'}</td>
                  <td>{t.nightMultiplier ? `${t.nightMultiplier}×` : '—'}</td>
                  <td className="sub">{new Date(t.effectiveFrom).toLocaleDateString()}</td>
                  <td>
                    <button disabled={busy === t.id} onClick={() => void retire(t.id)}>
                      {busy === t.id ? 'Retiring…' : 'Retire'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {retired.length > 0 && (
        <>
          <h3 className="sub">Retired</h3>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Price</th>
                <th>Modality</th>
                <th>Effective</th>
                <th>Retired</th>
              </tr>
            </thead>
            <tbody>
              {retired.map((t) => (
                <tr key={t.id} style={{ opacity: 0.6 }}>
                  <td>{t.code}</td>
                  <td>{t.label}</td>
                  <td>{t.unitRupees}</td>
                  <td>{t.modalityCode ?? '—'}</td>
                  <td className="sub">{new Date(t.effectiveFrom).toLocaleDateString()}</td>
                  <td className="sub">{t.effectiveTo ? new Date(t.effectiveTo).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
