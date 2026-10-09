import nodemailer from 'nodemailer';
import type { NotifyTransport, SendResult } from './notify.js';

/**
 * The one place nodemailer is touched, and the reason it is a port rather than a call inside
 * the sweep: the queue's behaviour — backoff, attempts, what counts as given up on — has to be
 * testable without a mail server, and a real relay has to be reachable from the same code path
 * so the tests are not the only thing that ever runs.
 */
export type SmtpSettings = {
  /** An SMTP connection URL, or empty when this deployment has no relay. */
  url: string | null;
  from: string | null;
};

const shortError = (err: unknown): string => {
  if (err instanceof Error) return err.message.slice(0, 140);
  return String(err).slice(0, 140);
};

export function createSmtpTransport(settings: SmtpSettings): NotifyTransport {
  if (!settings.url || !settings.from) {
    return {
      configured: false,
      label: 'not configured',
      async send(): Promise<SendResult> {
        return { ok: false, error: 'smtp_not_configured' };
      },
    };
  }

  const mailer = nodemailer.createTransport(settings.url);
  return {
    configured: true,
    // The host, not the credential: this string lands in an audit row, and an SMTP URL in the
    // form `smtp://user:pass@host` would otherwise write a password into the chain that a
    // regulator reads five years later.
    label: hostOf(settings.url),
    async send(message): Promise<SendResult> {
      try {
        const info = await mailer.sendMail({
          from: settings.from ?? undefined,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
        // A relay that accepted the message and returned no id is a relay that did not accept
        // the message, so the id is part of the success condition rather than decoration.
        return info.messageId ? { ok: true } : { ok: false, error: 'no_message_id' };
      } catch (err) {
        return { ok: false, error: shortError(err) };
      }
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'smtp';
  } catch {
    // A URL this function cannot parse will be rejected by nodemailer on the first send, and
    // `smtp` is enough for a log line to mean "the box with no hostname in it".
    return 'smtp';
  }
}
