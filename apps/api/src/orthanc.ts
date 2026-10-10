import type { Env } from './env.js';

/**
 * A refusal from the node, carried as a status rather than as prose, because the viewer
 * has to answer 404 for a study the node does not have and 502 for a node that is not
 * answering — and a reader staring at a black rectangle cannot tell those apart.
 */
export class OrthancError extends Error {
  constructor(readonly status: number, path: string) {
    super(`orthanc ${status} on ${path}`);
    this.name = 'OrthancError';
  }
}

export type OrthancClient = {
  ping: () => Promise<boolean>;
  get: <T>(path: string) => Promise<T>;
  /** Node-scoped reads, for a study whose storage node is not the deployment default. */
  nodeJson: <T>(baseUrl: string, path: string) => Promise<T>;
  nodeText: (baseUrl: string, path: string) => Promise<string>;
  nodeBytes: (baseUrl: string, path: string) => Promise<Uint8Array>;
};

export function createOrthancClient(env: Env['orthanc']): OrthancClient {
  const auth = 'Basic ' + Buffer.from(`${env.user}:${env.password}`).toString('base64');

  // Node-scoped, because a study lives on one node and a deployment has more than one.
  // The credential stays global: the schema has no per-node secret, and inventing one
  // here would be a second source of truth for something storage_nodes does not model.
  async function fetchOne(baseUrl: string, path: string, timeoutMs: number): Promise<Response> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new OrthancError(res.status, path);
    return res;
  }

  async function get<T>(path: string): Promise<T> {
    const res = await fetchOne(env.baseUrl, path, 8_000);
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
    // Study structure is a handful of kilobytes; the node is local, so eight seconds is
    // already generous, and a slower answer is a fault worth seeing.
    nodeJson: async <T,>(baseUrl: string, path: string) =>
      (await (await fetchOne(baseUrl, path, 8_000)).json()) as T,
    // A frame is the node decoding pixels and printing 4096 numbers per megapixel, which
    // is CPU work on the same box that holds the archive. Twenty seconds, and no retry:
    // a reader who scrolls again while this is in flight is the retry.
    nodeText: async (baseUrl: string, path: string) => (await fetchOne(baseUrl, path, 20_000)).text(),
    // A 16-bit PNG frame: the compressed bytes, not text-shaped numbers. Roughly 500×
    // smaller than the matlab endpoint for a 512×512 slice.
    nodeBytes: async (baseUrl: string, path: string) =>
      new Uint8Array(await (await fetchOne(baseUrl, path, 20_000)).arrayBuffer()),
  };
}
