import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * The HTTP half of the agent, and the only place that knows the api exists.
 *
 * It is a class with an injectable `fetch` rather than bare calls in the sweep because the two
 * behaviours that matter here — a 422 that means the bytes were wrong, and a connection that
 * never completed — have to be tested without a network, and a retry that cannot be tested is a
 * retry that fires twice.
 */

export type BatchOpen = {
  filesExpected: number;
  bytesDeclared: number;
  accessionHint?: string | null;
  studyDateHint?: string | null;
  modalityHint?: string | null;
};

export type BatchReply = { ok: true; batchId: string; putPath: string; sealPath: string };
export type PutReply = {
  ok: true; fileId: string; bytes: number; kind: string; quarantined: boolean; duplicate?: boolean;
};
export type SealReply = { ok: true; batchId: string; stored: number; quarantined: number };
export type BatchView = {
  ok: true;
  batch: { id: string; status: string; filesExpected: number; bytesReceived: number };
  files: { filename: string; bytes: number; sha256: string; status: string; errorCode: string | null }[];
};

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`http ${status}: ${code}`);
    this.name = 'AgentHttpError';
  }

  /** 4xx means the request was wrong and asking again will not help; 5xx and transport do not. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500
      // 408 and 429 are 4xx accidents of timing and load, not of the request.
      && this.status !== 408 && this.status !== 429;
  }
}

export type ClientOptions = {
  api: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Only set when the site is genuinely isolated; a token in cleartext is a token for whoever is listening. */
  allowInsecureHttp?: boolean;
};

export class AgentClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: ClientOptions) {
    const url = opts.api.trim().replace(/\/+$/, '');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !opts.allowInsecureHttp) {
      throw new Error(`${parsed.protocol}//${parsed.host} is not https. The agent sends its site token on`
        + ' every request, so it will not do that over cleartext. Put the api behind a certificate, or'
        + ' pass --allow-insecure-http if this machine really cannot see the network.');
    }
    if (opts.token.trim() === '') throw new Error('no agent token configured');
    this.base = url;
    this.token = opts.token.trim();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** The label the operator sees. Never the credential-bearing value. */
  get host(): string {
    return new URL(this.base).host;
  }

  private async request<T>(method: string, pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    let response: Response;
    // AbortSignal.timeout rather than a hand-rolled timer: a request that neither completed nor
    // failed is the failure mode that strands an agent on a modality PC at 3 a.m. with a
    // half-open batch and no log line.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.doFetch(`${this.base}${pathname}`, { ...init, method, headers, signal });
    } catch (err) {
      throw new Error(`${method} ${pathname} to ${this.host} did not complete: ${(err as Error).message}`);
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      // A proxy page or a plain-text error is not a reason to lose the status code, which is
      // the only part of the answer that decides whether to retry.
      body = { error: `non_json_response:${response.status}` };
    }
    if (!response.ok) {
      throw new AgentHttpError(response.status, String(body.error ?? `http_${response.status}`), body);
    }
    return body as T;
  }

  openBatch(input: BatchOpen): Promise<BatchReply> {
    return this.request<BatchReply>('POST', '/v1/uploads/batches', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filesExpected: input.filesExpected,
        bytesDeclared: input.bytesDeclared,
        accessionHint: input.accessionHint ?? null,
        studyDateHint: input.studyDateHint ?? null,
        modalityHint: input.modalityHint ?? null,
      }),
    });
  }

  /**
   * Streamed from disk, not buffered: an agent runs on the same small machine as the modality,
   * and a 900 MB batch loaded into memory to be uploaded would take the scanner's workstation
   * down while a study is queued on it.
   */
  putFile(batchId: string, filename: string, filePath: string, sha256: string): Promise<PutReply> {
    return this.request<PutReply>('PUT', `/v1/uploads/batches/${batchId}/files/${encodeURIComponent(filename)}`, {
      body: Readable.toWeb(createReadStream(filePath)) as ReadableStream,
      duplex: 'half',
      headers: { 'content-type': 'application/dicom', 'x-content-sha256': sha256 },
    } as RequestInit);
  }

  sealBatch(batchId: string): Promise<SealReply> {
    return this.request<SealReply>('POST', `/v1/uploads/batches/${batchId}/seal`, {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  }

  /** Read back what the server says it holds. The agent's own count is not the evidence. */
  getBatch(batchId: string): Promise<BatchView> {
    return this.request<BatchView>('GET', `/v1/uploads/batches/${batchId}`);
  }

  /** Cheap liveness probe, so a sweep can say "cannot reach the api" instead of a stack trace. */
  health(): Promise<boolean> {
    return this.request<{ status: string }>('GET', '/health/ready')
      .then(() => true)
      .catch(() => false);
  }
}
