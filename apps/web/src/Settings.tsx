import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type TenantProfile } from './api';

type Session = { user: { id: number; role: string; name?: string; tenantId: number | null } };

export function Settings({ show, session }: { show: boolean; session: Session }) {
  if (!show) return null;
  return (
    <>
      <MyProfile session={session} />
      {session.user.role === 'owner' && session.user.tenantId !== null && (
        <TenantSettings tenantId={session.user.tenantId} />
      )}
    </>
  );
}

function MyProfile({ session }: { session: Session }) {
  const [current, setCurrent] = useState('');
  const [next1, setNext1] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setFlash(null);
    if (next1.length < 14) return setError('password shorter than 14 characters');
    if (next1 !== next2) return setError('new passwords do not match');
    if (!current) return setError('current password is required');
    setBusy(true);
    try {
      await api.changePassword(current, next1);
      setCurrent('');
      setNext1('');
      setNext2('');
      setFlash('Password changed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>My profile</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
        <div><span className="sub">Name</span><div>{session.user.name ?? '—'}</div></div>
        <div><span className="sub">Role</span><div><span className="chip">{session.user.role}</span></div></div>
      </div>

      <h3 className="sub" style={{ marginTop: '20px' }}>Change password</h3>
      {error && <div className="error">{error}</div>}
      {flash && <div className="state green">{flash}</div>}
      <div className="filters">
        <input type="password" placeholder="current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input type="password" placeholder="new password (min 14 chars)" value={next1} onChange={(e) => setNext1(e.target.value)} />
        <input type="password" placeholder="confirm new password" value={next2} onChange={(e) => setNext2(e.target.value)} />
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </div>
  );
}

function TenantSettings({ tenantId }: { tenantId: number }) {
  const [tenant, setTenant] = useState<TenantProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Partial<TenantProfile>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.tenantProfile(tenantId);
      if (res.tenant) {
        setTenant(res.tenant);
        setForm({
          legalName: res.tenant.legalName,
          billingName: res.tenant.billingName ?? '',
          country: res.tenant.country,
          stateCode: res.tenant.stateCode ?? '',
          gstin: res.tenant.gstin ?? '',
          timezone: res.tenant.timezone,
          contactName: res.tenant.contactName ?? '',
          contactEmail: res.tenant.contactEmail ?? '',
          contactPhone: res.tenant.contactPhone ?? '',
          signatureLine: res.tenant.signatureLine ?? '',
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot load tenant profile');
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const res = await api.updateTenantProfile(form);
      setTenant(res.tenant);
      setFlash('Tenant profile saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot save tenant profile');
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof TenantProfile>(k: K, v: TenantProfile[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (!tenant) return null;

  return (
    <div className="card">
      <h2>Tenant settings</h2>
      <div className="sub" style={{ marginBottom: '12px' }}>
        Code <span className="chip">{tenant.code}</span> · status <span className="chip">{tenant.status}</span>
      </div>

      {error && <div className="error">{error}</div>}
      {flash && <div className="state green">{flash}</div>}

      <h3 className="sub">Legal identity</h3>
      <div className="filters">
        <input placeholder="legal name" value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
        <input placeholder="billing name" value={form.billingName ?? ''} onChange={(e) => set('billingName', e.target.value)} />
        <input placeholder="country" value={form.country ?? ''} onChange={(e) => set('country', e.target.value)} style={{ width: '140px' }} />
        <input placeholder="state code" value={form.stateCode ?? ''} onChange={(e) => set('stateCode', e.target.value)} style={{ width: '140px' }} />
        <input placeholder="GSTIN" value={form.gstin ?? ''} onChange={(e) => set('gstin', e.target.value)} style={{ width: '200px' }} />
      </div>

      <h3 className="sub">Contact</h3>
      <div className="filters">
        <input placeholder="contact name" value={form.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} />
        <input placeholder="contact email" value={form.contactEmail ?? ''} onChange={(e) => set('contactEmail', e.target.value)} />
        <input placeholder="contact phone" value={form.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} />
      </div>

      <h3 className="sub">Reports</h3>
      <div className="filters">
        <input placeholder="signature line (appears on every signed report)" value={form.signatureLine ?? ''}
          onChange={(e) => set('signatureLine', e.target.value)} style={{ flex: '1 1 400px' }} />
      </div>

      <h3 className="sub">Locale</h3>
      <div className="filters">
        <input placeholder="timezone (e.g. Asia/Kolkata)" value={form.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)} style={{ width: '240px' }} />
      </div>

      <button className="primary" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save tenant settings'}
      </button>
    </div>
  );
}
