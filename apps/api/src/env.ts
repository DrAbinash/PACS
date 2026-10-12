import { readFileSync } from 'node:fs';

export type Env = {
  port: number;
  bindHost: string;
  dbUrl: string;
  orthanc: { baseUrl: string; user: string; password: string };
  sessionSecret: string;
  uploadSigningSecret: string;
  publicUrl: string;
  inboxRoot: string;
  logLevel: string;
};

// Anchored, not substring-matching: a real base64 secret may contain almost any
// letters, and an earlier draft of this guard rejected a legitimate passphrase that
// merely happened to contain the word "secret". What is refused here is a
// placeholder or a lazy whole-value default.
const PLACEHOLDER = /^(<generated|changeme|password|secret|test|todo|fixme|\s+)$|^\s*1234+\s*$/i;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Fail closed on a placeholder instead of starting a service that would accept
// one. A deployment that boots with a weak secret is a breach with a uptime graph.
function strong(name: string, minLength = 24): string {
  const value = required(name);
  // Placeholder check before length check: "1234" is a placeholder, and reporting
  // it as merely too short would invite an operator to fix it by padding.
  if (PLACEHOLDER.test(value)) throw new Error(`${name} still contains a placeholder value`);
  if (value.length < minLength) throw new Error(`${name} is shorter than ${minLength} characters`);
  return value;
}

export function loadEnv(): Env {
  return {
    port: Number(process.env.PORT ?? 3001),
    // Loopback is the safe default for a bare-host dev run; a container must
    // bind every interface or the proxy beside it gets connection refused
    // while the in-container healthcheck stays green — the one failure mode a
    // healthcheck cannot catch.
    bindHost: process.env.TR_BIND_HOST ?? '127.0.0.1',
    dbUrl: required('TR_DB_URL'),
    orthanc: {
      baseUrl: required('TR_ORTHANC_URL'),
      user: required('TR_ORTHANC_USER'),
      // Read from a file when the compose secret is mounted rather than
      // interpolated, so the value never appears in `docker inspect`.
      password: process.env.TR_ORTHANC_PASSWORD_FILE
        ? readFileSync(process.env.TR_ORTHANC_PASSWORD_FILE, 'utf8').trim()
        : strong('TR_ORTHANC_PASSWORD', 12),
    },
    sessionSecret: strong('TR_SESSION_SECRET', 32),
    uploadSigningSecret: strong('TR_UPLOAD_SIGNING_SECRET', 24),
    publicUrl: required('TR_PUBLIC_URL'),
    inboxRoot: process.env.TR_INBOX_ROOT ?? '/app/inbox',
    logLevel: process.env.TR_LOG_LEVEL ?? 'info',
  };
}
