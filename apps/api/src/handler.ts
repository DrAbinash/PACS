import type { NextFunction, Request, Response } from 'express';
import type { RequestHandler } from 'express';
import type { Ctx } from './auth.js';

// Express 4 calls a route handler and throws away the promise it returns. A
// rejection therefore never reaches the error middleware: it reaches Node's
// `unhandledRejection` hook, and Node's default action for that is to exit.
//
// Every read in this API is an await on postgres, so one dropped connection or one
// mis-bound SQL template was enough to kill the process while the container runtime
// restarted it a second later. To a reader on the panel that looks like a new
// outage, and it destroys the study-tree cache along with the request that was
// carrying a case someone had opened.
//
// `ah` restores the boundary Express 5 has natively: a rejection is forwarded to
// `next`, which means `errorHandler` below, which means the process stays up and
// answers 500. It also catches a synchronous throw, so a handler can be moved onto
// it without knowing which kind of failure it has.
//
// Every route and guard registration is wrapped, and the guard test in
// test/route-boundary.test.ts fails the build if a bare `async` handler is added.
export function ah(
  fn: (req: Ctx, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    let pending: unknown;
    try {
      pending = fn(req as Ctx, res, next);
    } catch (err) {
      next(err);
      return;
    }
    // A handler that returns a plain value needs nothing from here; only a promise
    // can fail after Express has already moved on, and that is the failure this
    // boundary exists for.
    if (pending instanceof Promise) pending.catch(next);
  };
}

// The single place a failure becomes an HTTP response. Mounted last in app.ts, so
// anything that reached `next` with an error — a rejected read from `ah`, a body
// parser overflow, a malformed JSON document — is answered here and nowhere else.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // A handler that failed after streaming had started — a study tree half-sent, a
  // PDF truncated mid-chunk — cannot be answered twice. Handing the error back to
  // Express tears the socket down instead of throwing ERR_HTTP_HEADERS_SENT from
  // inside this middleware, which would be the failure it exists to catch.
  if (res.headersSent) return next(err);
  // Never echo an exception message: it can carry a connection string or a path
  // from the ingest layer. The client gets a code; the log gets the stack.
  console.error('unhandled', err);
  res.status(500).json({ ok: false, error: 'internal_error' });
}
