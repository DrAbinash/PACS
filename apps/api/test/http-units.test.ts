import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCookie, COOKIE } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const NAMES = [
  'TR_DB_URL', 'TR_ORTHANC_URL', 'TR_ORTHANC_USER', 'TR_ORTHANC_PASSWORD',
  'TR_SESSION_SECRET', 'TR_UPLOAD_SIGNING_SECRET', 'TR_PUBLIC_URL',
] as const;

const good: Record<string, string> = {
  TR_DB_URL: 'postgresql://u:p@h/db',
  TR_ORTHANC_URL: 'http://tr-orthanc:8042',
  TR_ORTHANC_USER: 'telrad-api',
  TR_ORTHANC_PASSWORD: 'ci-orthanc-fixture-not-a-real-credential',
  TR_SESSION_SECRET: 'Yf7gLm2wRt9kQz4xBn6vcD1aPe8hJs3gUo5iTy7rLk',
  TR_UPLOAD_SIGNING_SECRET: 'Vq2zNc6xLb9mKj4ghT7yuW1eRt8iOp0aSd3fGh5jKl7zXc',
  TR_PUBLIC_URL: 'https://telrad.example:8443',
};

// The two things testable without a database are the ones that fail silently:
// cookie parsing, and a secret guard that quietly accepts a weak value.
describe('readCookie', () => {
  const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} } as never);

  it('reads the session cookie among others', () => {
    expect(readCookie(req(`other=1; ${COOKIE}=abc%20def; third=2`), COOKIE)).toBe('abc def');
  });

  it('returns null when it is absent or empty', () => {
    expect(readCookie(req('other=1'), COOKIE)).toBeNull();
    expect(readCookie(req(), COOKIE)).toBeNull();
  });

  it('does not confuse a prefix for the session cookie', () => {
    expect(readCookie(req(`${COOKIE}_x=nope`), COOKIE)).toBeNull();
  });
});

describe('loadEnv', () => {
  beforeEach(() => {
    for (const n of NAMES) process.env[n] = good[n]!;
  });

  afterEach(() => {
    for (const n of NAMES) delete process.env[n];
  });

  it('accepts a complete, strong environment', () => {
    const env = loadEnv();
    expect(env.orthanc.baseUrl).toBe('http://tr-orthanc:8042');
    expect(env.publicUrl).toBe('https://telrad.example:8443');
  });

  it('refuses the four-digit default an earlier stack on this hardware shipped with', () => {
    process.env.TR_ORTHANC_PASSWORD = '1234';
    expect(() => loadEnv()).toThrow(/placeholder/);
  });

  it('refuses a whole-value word that is not a secret', () => {
    process.env.TR_SESSION_SECRET = 'password';
    expect(() => loadEnv()).toThrow(/placeholder/);
  });

  it('refuses a short session secret', () => {
    process.env.TR_SESSION_SECRET = 'abc';
    expect(() => loadEnv()).toThrow(/shorter than/);
  });

  it('refuses to start with no database url', () => {
    delete process.env.TR_DB_URL;
    expect(() => loadEnv()).toThrow(/TR_DB_URL/);
  });

  it('accepts a secret that merely contains an ordinary word', () => {
    process.env.TR_SESSION_SECRET = 'thisValueContainsTestAnd1234InsideItButIsLong';
    expect(() => loadEnv()).not.toThrow();
  });
});
