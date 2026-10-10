import { describe, expect, it } from 'vitest';
import { AgentClient, AgentHttpError } from '../src/client.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: { status: number; body: unknown }, calls: Call[] = []) {
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'supersecrettokenvalue-0123456789abcdef';
const client = (reply: { status: number; body: unknown }, calls: Call[] = [], over = {}) =>
  new AgentClient({
    api: 'https://telrad.example.com', token: TOKEN,
    fetchImpl: fakeFetch(reply, calls).impl, ...over,
  });

describe('what the agent will not do', () => {
  it('refuses a cleartext api, because the site token rides on every request', () => {
    expect(() => new AgentClient({ api: 'http://192.168.1.9:3101', token: TOKEN }))
      .toThrow(/not https/);
  });

  it('takes cleartext only when it is told to, in the argument that says so', () => {
    const c = new AgentClient({
      api: 'http://192.168.1.9:3101', token: TOKEN, allowInsecureHttp: true,
      fetchImpl: fakeFetch({ status: 200, body: {} }).impl,
    });
    expect(c.host).toBe('192.168.1.9:3101');
  });

  it('refuses an empty token instead of sending anonymous requests that would 401 later', () => {
    expect(() => new AgentClient({ api: 'https://x.example', token: '  ' })).toThrow(/no agent token/);
  });

  it('names the origin it is talking to and never the credential', () => {
    const c = client({ status: 500, body: { error: 'boom' } });
    expect(c.host).toBe('telrad.example.com');
    expect(JSON.stringify(Object.getOwnPropertyNames(c))).not.toContain(TOKEN);
  });
});

describe('the requests', () => {
  it('opens a batch with the declared shape and the token as a bearer', async () => {
    const calls: Call[] = [];
    const c = client({ status: 201, body: { ok: true, batchId: 'b-9', putPath: '/p', sealPath: '/s' } }, calls);
    const reply = await c.openBatch({ filesExpected: 3, bytesDeclared: 1500, accessionHint: 'ACC-4477' });
    expect(reply.batchId).toBe('b-9');
    expect(calls[0]!.url).toBe('https://telrad.example.com/v1/uploads/batches');
    expect((calls[0]!.init.headers as Headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      filesExpected: 3, bytesDeclared: 1500, accessionHint: 'ACC-4477', modalityHint: null,
    });
  });

  it('puts a file with the digest it computed, under the encoded name', async () => {
    const calls: Call[] = [];
    const c = client({ status: 200, body: { ok: true, fileId: 'f-1', bytes: 10, kind: 'dicom', quarantined: false } }, calls);
    await c.putFile('b-9', 'img 0001.dcm', '/watch/A/img 0001.dcm', 'abc123');
    expect(calls[0]!.url).toBe('https://telrad.example.com/v1/uploads/batches/b-9/files/img%200001.dcm');
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get('x-content-sha256')).toBe('abc123');
    expect(headers.get('content-type')).toBe('application/dicom');
    expect(calls[0]!.init.method).toBe('PUT');
  });

  it('seals and reads the batch back, because its own count is not the evidence', async () => {
    const calls: Call[] = [];
    const c = client({ status: 200, body: { ok: true, batchId: 'b-9', stored: 2, quarantined: 1 } }, calls);
    await c.sealBatch('b-9');
    await c.getBatch('b-9');
    expect(calls.map((x) => `${(x.init.method ?? 'GET')} ${x.url.split('/').pop()}`))
      .toEqual(['POST seal', 'GET b-9']);
  });

  it('carries a timeout into every request', async () => {
    const calls: Call[] = [];
    const c = client({ status: 200, body: { ok: true } }, calls, { timeoutMs: 5_000 });
    await c.getBatch('b-1');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('what an answer means', () => {
  it('turns a 4xx body into a code the retry rule can read', async () => {
    const c = client({ status: 422, body: { ok: false, error: 'sha256_mismatch' } });
    const err = await c.getBatch('b-1').catch((e: unknown) => e) as AgentHttpError;
    expect(err).toBeInstanceOf(AgentHttpError);
    expect(err.code).toBe('sha256_mismatch');
    expect(err.permanent).toBe(true);
  });

  it('keeps retrying what a server fault says to retry', async () => {
    const c = client({ status: 503, body: { error: 'unavailable' } });
    const err = await c.getBatch('b-1').catch((e: unknown) => e) as AgentHttpError;
    expect(err.permanent).toBe(false);
  });

  it('does not treat a rate limit or a timeout as a bad request', async () => {
    for (const status of [408, 429]) {
      const c = client({ status, body: { error: 'slow_down' } });
      const err = await c.getBatch('b-1').catch((e: unknown) => e) as AgentHttpError;
      expect(err.permanent).toBe(false);
    }
  });

  it('survives a proxy that answered HTML, and keeps the status that decides the retry', async () => {
    const c = client({ status: 502, body: '<html>502 Bad Gateway</html>' });
    const err = await c.getBatch('b-1').catch((e: unknown) => e) as AgentHttpError;
    expect(err.status).toBe(502);
    expect(err.code).toMatch(/non_json_response/);
  });

  it('reports a request that never completed without repeating the credential in the message', async () => {
    const impl = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3101'); }) as unknown as typeof fetch;
    const c = new AgentClient({ api: 'https://telrad.example', token: TOKEN, fetchImpl: impl });
    const err = await c.openBatch({ filesExpected: 1, bytesDeclared: 1 }).catch((e: unknown) => e) as Error;
    expect(err.message).toContain('did not complete');
    expect(err.message).toContain('telrad.example');
    expect(err.message).not.toContain(TOKEN);
  });

  it('answers health with a yes or no rather than an exception', async () => {
    expect(await client({ status: 200, body: { status: 'ready' } }).health()).toBe(true);
    expect(await client({ status: 500, body: {} }).health()).toBe(false);
  });
});
