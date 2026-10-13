import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Site, type SiteToken } from './api';

export function Sites({ show }: { show: boolean }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [tokens, setTokens] = useState<Map<number, SiteToken[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newAe, setNewAe] = useState('');
  const [busy, setBusy] = useState(false);
  const [expandedSite, setExpandedSite] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.sites();
      setSites(res.sites);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : 'cannot load sites');
    }
  }, []);

  useEffect(() => {
    if (show) void load();
  }, [show, load]);

  const loadTokens = async (siteId: number) => {
    try {
      const res = await api.siteTokens(siteId);
      setTokens((prev) => new Map(prev).set(siteId, res.tokens));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot load tokens');
    }
  };

  const createSite = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSite({ name: newName.trim(), aeTitle: newAe.trim() || undefined });
      setNewName('');
      setNewAe('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot create site');
    } finally {
      setBusy(false);
    }
  };

  const issueToken = async (siteId: number) => {
    try {
      await api.issueSiteToken(siteId);
      await loadTokens(siteId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot issue token');
    }
  };

  const revokeToken = async (tokenId: number, siteId: number) => {
    try {
      await api.revokeToken(tokenId);
      await loadTokens(siteId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'cannot revoke token');
    }
  };

  if (!show) return null;

  return (
    <div className="card">
      <h2>Imaging sites</h2>
      {error && <div className="error">{error}</div>}

      <div className="filters">
        <input placeholder="site name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input placeholder="AE title (optional)" value={newAe} onChange={(e) => setNewAe(e.target.value)} />
        <button className="primary" disabled={busy || !newName.trim()} onClick={() => void createSite()}>
          {busy ? 'Creating…' : 'Add site'}
        </button>
      </div>

      {sites.length === 0 && !error && <div className="sub">No sites registered yet.</div>}
      {sites.map((site) => (
        <div key={site.id} style={{ borderTop: '1px solid var(--line)', paddingTop: '10px', marginTop: '10px' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <strong>{site.name}</strong>
            {site.aeTitle && <span className="sub">AE: {site.aeTitle}</span>}
            <span className="sub">created {new Date(site.createdAt).toLocaleDateString()}</span>
            <button
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                if (expandedSite === site.id) {
                  setExpandedSite(null);
                } else {
                  setExpandedSite(site.id);
                  void loadTokens(site.id);
                }
              }}
            >
              {expandedSite === site.id ? 'Hide tokens' : 'Manage tokens'}
            </button>
          </div>
          {expandedSite === site.id && (
            <div style={{ marginTop: '10px', paddingLeft: '20px' }}>
              <button className="primary" onClick={() => void issueToken(site.id)}>Issue new token</button>
              {(tokens.get(site.id) ?? []).length === 0 && (
                <div className="sub" style={{ marginTop: '8px' }}>No tokens issued.</div>
              )}
              {(tokens.get(site.id) ?? []).map((token) => (
                <div key={token.id} className="workcase">
                  <div className="who">
                    <strong>Token #{token.id}</strong>
                    <div className="sub">
                      {token.label ?? 'no label'} · created {new Date(token.createdAt).toLocaleDateString()}
                      {token.lastUsedAt && ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                    </div>
                    {token.revokedAt && <div className="sub state red">revoked</div>}
                  </div>
                  {!token.revokedAt && (
                    <button onClick={() => void revokeToken(token.id, site.id)}>Revoke</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
