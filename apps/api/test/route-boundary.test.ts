import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import express from 'express';
import { ah, errorHandler } from '../src/handler.js';

// This file guards one rule: no route in the API may hand Express a promise it does
// not observe. Express 4 does not await a handler, so a rejected database read is an
// `unhandledRejection`, and the default action for that in Node is to terminate the
// process. The last test proves that failure is real; the others prove the boundary
// closes it, and the first two make it impossible to add a route outside it.

const REGISTRATION = /^\s*\w+\.(get|post|put|patch|delete)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

function registrationLines(): { file: string; line: string; n: number }[] {
  return sources(fileURLToPath(new URL('../src', import.meta.url))).flatMap((file) =>
    readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ file, line, n: i + 1 }))
      .filter((entry) => REGISTRATION.test(entry.line)));
}

async function serve(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

describe('the route surface of the API', () => {
  it('is scanned in full', () => {
    // A scan that stopped matching anything would pass the next test silently. This
    // one fails instead, so the guard cannot rot into decoration.
    expect(registrationLines().length).toBeGreaterThanOrEqual(45);
  });

  it('wraps every async handler in ah()', () => {
    const bare = registrationLines()
      .filter((entry) => entry.line.includes('async (') && !entry.line.includes('ah(async ('))
      .map((entry) => `${path.relative(process.cwd(), entry.file)}:${entry.n}: ${entry.line.trim()}`);
    expect(bare).toEqual([]);
  });
});

describe('ah()', () => {
  it('forwards a rejected handler to the error middleware', async () => {
    const app = express();
    app.get('/rejects', ah(async () => { throw new Error('connection reset'); }));
    app.use(errorHandler);
    const { url, close } = await serve(app);
    const res = await fetch(`${url}/rejects`);
    await close();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'internal_error' });
  });

  it('forwards a synchronous throw as well', async () => {
    const app = express();
    app.get('/throws', ah(() => { throw new TypeError('not a function'); }));
    app.use(errorHandler);
    const { url, close } = await serve(app);
    const res = await fetch(`${url}/throws`);
    await close();
    expect(res.status).toBe(500);
  });

  it('hands back a failure that arrived after streaming started', async () => {
    const app = express();
    app.get('/streamed', ah(async (_req, res) => {
      res.write('partial');
      throw new Error('the study tree ended early');
    }));
    app.use(errorHandler);
    const { url, close } = await serve(app);
    const res = await fetch(`${url}/streamed`);
    // The headers were already on the wire, so errorHandler cannot answer twice: it
    // returns the error to Express and the socket is torn down. The client's body
    // read fails instead of delivering a report that stops in the middle.
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    // And the process is still here for the next request.
    const next = await fetch(`${url}/unknown-path`);
    await close();
    expect(next.status).toBe(404);
  });
});

describe('Express 4 without the boundary', () => {
  it('never answers the request and takes the process with it', async () => {
    // A child process, because the point of the measurement is that the host dies —
    // inside the test runner that would only be reported as someone else's failure.
    // Express is asked the same way the API asks it: one async handler, one error
    // middleware that would have answered 500 had the rejection ever reached `next`.
    const script = [
      "const express = require('express');",
      'const app = express();',
      "app.get('/bare', async () => { throw new Error('connection reset'); });",
      'app.use((err, _req, res, next) => {',
      '  if (res.headersSent) return next(err);',
      "  console.log('error middleware saw ' + err.message);",
      "  res.status(500).json({ ok: false, error: 'internal_error' });",
      '});',
      "const server = app.listen(0, '127.0.0.1', () => {",
      '  const port = server.address().port;',
      "  fetch('http://127.0.0.1:' + port + '/bare')",
      "    .then((r) => console.log('answered ' + r.status))",
      "    .catch((e) => console.log('client saw ' + e.name));",
      '});',
      "setTimeout(() => { console.log('survived'); process.exit(0); }, 1500);",
    ].join('\n');

    const result = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(process.execPath, ['--input-type=commonjs', '-e', script], { timeout: 20_000 },
        (error, stdout, stderr) => {
          resolve({
            code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
            text: `${stdout}\n${stderr}`.replace(/\r/g, ''),
          });
        });
    });

    // The production failure in miniature. Three things are all true at once, and
    // together they are the reason every route is wrapped: the error middleware that
    // was mounted for this exact case never ran, the reader's request was never
    // answered, and the service exited non-zero.
    expect(result.text).toContain('connection reset');
    expect(result.text).not.toContain('error middleware saw');
    expect(result.text).not.toContain('answered');
    expect(result.text).not.toContain('survived');
    expect(result.code).not.toBe(0);
  }, 30_000);
});
