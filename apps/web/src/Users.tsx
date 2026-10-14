import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type UserRecord } from './api';

const ROLES = ['owner', 'console', 'center_staff', 'radiologist', 'reviewer', 'typist'] as const;
const STATUSES = ['invited', 'active', 'locked', 'disabled'] as const;
const GRADES = ['junior', 'senior', 'chief'] as const;
const CLINICIAN_ROLES = ['radiologist', 'reviewer'];

export function Users({ show }: { show: boolean }) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.users();
      setUsers(res.users);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot load users');
    }
  }, []);

  useEffect(() => {
    if (show) void load();
  }, [show, load]);

  const setStatus = async (id: number, status: typeof STATUSES[number]) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(id, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot update user');
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (id: number, email: string) => {
    if (!confirm(`Generate a new temporary password for ${email}? The old password will stop working immediately.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.resetUserPassword(id);
      setFlash(`New password for ${email}: ${res.tempPassword} — share out-of-band, it will not be shown again.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot reset password');
    } finally {
      setBusy(false);
    }
  };

  if (!show) return null;

  return (
    <div className="card">
      <h2>
        Users
        <button
          className="primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? 'Cancel' : 'Add user'}
        </button>
      </h2>

      {error && <div className="error">{error}</div>}
      {flash && (
        <div className="notebar" style={{ color: 'var(--text)' }}>
          {flash}
          <button style={{ marginLeft: '12px' }} onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}

      {showCreate && (
        <CreateForm
          onCreated={async (u, pw) => {
            setShowCreate(false);
            setFlash(`Created ${u.email}. Temporary password: ${pw} — share out-of-band.`);
            await load();
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th><th>Email</th><th>Role</th>
            <th>Status</th><th>2FA</th><th>Last login</th><th></th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && !error && (
            <tr><td colSpan={7} className="sub">No users yet.</td></tr>
          )}
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.displayName}</strong>
                {u.clinician && (
                  <div className="sub">
                    {u.clinician.grade} · {u.clinician.registrationCouncil} {u.clinician.registrationNumber}
                  </div>
                )}
              </td>
              <td>{u.email}</td>
              <td><span className="chip">{u.role}</span></td>
              <td>
                <select
                  value={u.status}
                  disabled={busy}
                  onChange={(e) => void setStatus(u.id, e.target.value as typeof STATUSES[number])}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td>{u.totpEnabled ? <span className="state green">on</span> : <span className="sub">off</span>}</td>
              <td className="sub">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
              <td>
                <button disabled={busy} onClick={() => void resetPassword(u.id, u.email)}>
                  Reset password
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateForm({
  onCreated, onError,
}: {
  onCreated: (u: UserRecord, pw: string) => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<typeof ROLES[number]>('center_staff');
  const [council, setCouncil] = useState('');
  const [regNo, setRegNo] = useState('');
  const [grade, setGrade] = useState<typeof GRADES[number]>('junior');
  const [subs, setSubs] = useState('');
  const [mods, setMods] = useState('');
  const [maxQueue, setMaxQueue] = useState('5');
  const [night, setNight] = useState(false);
  const [busy, setBusy] = useState(false);

  const needsClinician = CLINICIAN_ROLES.includes(role);

  const submit = async () => {
    if (!email.includes('@') || !displayName.trim()) {
      onError('email and display name are required');
      return;
    }
    if (needsClinician && (!council.trim() || !regNo.trim())) {
      onError('readers need a registration council and number');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createUser({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        role,
        clinician: needsClinician
          ? {
              registrationCouncil: council.trim(),
              registrationNumber: regNo.trim(),
              grade,
              subspecialtyCodes: subs,
              modalityCodes: mods,
              maxQueueSize: Number(maxQueue) || 5,
              acceptsNight: night,
            }
          : undefined,
      });
      onCreated(res.user, res.tempPassword);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'cannot create user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 0' }}>
      <div className="filters">
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as typeof ROLES[number])}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {needsClinician && (
        <>
          <h3 className="sub">Clinician profile</h3>
          <div className="filters">
            <input placeholder="registration council" value={council} onChange={(e) => setCouncil(e.target.value)} />
            <input placeholder="registration number" value={regNo} onChange={(e) => setRegNo(e.target.value)} />
            <select value={grade} onChange={(e) => setGrade(e.target.value as typeof GRADES[number])}>
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className="filters">
            <input placeholder="subspecialties (comma-sep, e.g. MR-HEAD,CT-HEAD)" value={subs} onChange={(e) => setSubs(e.target.value)} />
            <input placeholder="modalities (e.g. MR,CT)" value={mods} onChange={(e) => setMods(e.target.value)} />
            <input type="number" min={1} max={50} placeholder="max queue" value={maxQueue}
              onChange={(e) => setMaxQueue(e.target.value)} style={{ width: '120px' }} />
            <label>
              <input type="checkbox" checked={night} onChange={(e) => setNight(e.target.checked)} />
              accepts night cases
            </label>
          </div>
        </>
      )}

      <button className="primary" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create user'}
      </button>
    </div>
  );
}
