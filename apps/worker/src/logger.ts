import pino from 'pino';

// Structured logging for the worker. Every log line is JSON with a timestamp, level,
// and message, plus any structured fields the caller passes. The operator's 2 a.m. log
// read stays readable via `pino-pretty` in development; in production, JSON output
// feeds directly into log aggregation (Loki, Cloudflare Logpush, etc.).
//
// The worker's per-tick counts are perfect candidates for structured fields: instead of
// parsing "dispatch offered=3 expired=1" from a string, a log aggregator can query
// `offered > 0` directly.

const level = process.env.TR_LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  // In development, pretty-print makes the logs human-readable. In production, JSON
  // is what log aggregators expect. The TR_LOG_PRETTY env var overrides the default.
  transport: process.env.TR_LOG_PRETTY === '1'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

// Child loggers add context (e.g., nodeId) to every log line without repeating it.
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
