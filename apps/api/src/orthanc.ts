import type { Env } from './env.js';

export type OrthancClient = {
  ping: () => Promise<boolean>;
  get: <T>(path: string) => Promise<T>;
};

export function createOrthancClient(env: Env['orthanc']): OrthancClient {
  const auth = 'Basic ' + Buffer.from(`${env.user}:${env.password}`).toString('base64');

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${env.baseUrl}${path}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`orthanc ${res.status} on ${path}`);
    return await res.json() as T;
  }

  return {
    // A readiness probe must not crash the api, so a refusal is reported as false
    // rather than thrown.
    //
    // /system and not /ping: on the pinned orthancteam build /ping answers 404 even
    // with a valid credential (measured: 401 unauthenticated, 404 authenticated),
    // so a probe on it reports a healthy image plane as dead. /system answers 200
    // and carries the version, which is the thing an operator wants to have seen.
    ping: async () => {
      try {
        const res = await fetch(`${env.baseUrl}/system`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(4_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    get,
  };
}
