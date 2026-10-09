export type PresenceColor = 'green' | 'amber' | 'red';

export type PanelRow = {
  userId: number;
  name: string;
  role: string;
  grade: 'junior' | 'senior' | 'chief';
  registration: string;
  subspecialtyCodes: string[];
  modalityCodes: string[];
  tenantId: number | null;
  openCases: number;
  maxQueueSize: number;
  declaredState: 'receiving' | 'paused' | 'away' | 'offline';
  declaredSince: string | null;
  lastSeenAt: string | null;
  color: PresenceColor;
  code: string;
  label: string;
  routable: boolean;
  sinceSeenSeconds: number | null;
  onShift: { kind: string; startsAt: string; endsAt: string } | null;
};

export type Panel = {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  panel: PanelRow[];
};

export type Session = {
  ok: boolean;
  user: { id: number; role: string; name?: string; tenantId: number | null };
  clinician: unknown;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(res.status, String(body.error ?? res.statusText), String(body.error ?? ''));
  }
  return body as T;
}

export const api = {
  session: () => call<Session>('/v1/auth/session'),
  login: (email: string, password: string) =>
    call<Session>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => call<{ ok: boolean }>('/v1/auth/logout', { method: 'POST', body: '{}' }),
  heartbeat: () =>
    call<{ color: PresenceColor; code: string; label: string; routable: boolean; openCases: number; maxQueueSize: number }>(
      '/v1/presence/heartbeat', { method: 'POST', body: '{}' }),
  declare: (state: string) =>
    call<{ ok: boolean; state: string }>('/v1/presence', { method: 'PATCH', body: JSON.stringify({ state }) }),
  panel: () => call<Panel>('/v1/panel'),
};
