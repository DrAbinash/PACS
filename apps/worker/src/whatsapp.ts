import type { SendResult } from './notify.js';

/**
 * The one place the WhatsApp Cloud API is touched, for the same reason SMTP is a port: the
 * queue's behaviour — backoff, attempts, what counts as given up on — has to be testable
 * without a Meta account, and the real API has to be reachable from the same code path when the
 * credentials arrive.
 *
 * This deployment ships with no credentials, and that is a supported state rather than a
 * configuration error: without TR_WHATSAPP_TOKEN / TR_WHATSAPP_PHONE_ID / TR_WHATSAPP_TEMPLATE
 * the transport reports `configured: false` and every whatsapp row in the outbox waits exactly
 * the way email rows wait on a box with no relay. Nothing here needs to change when the Meta
 * API is granted — the values go into env and the queue starts moving.
 */
export type WhatsAppSettings = {
  /** A permanent Cloud API token from the Meta app, or empty when this deployment has none. */
  token: string | null;
  /** The phone number id the messages are sent from, or empty when there is none. */
  phoneNumberId: string | null;
  /** The name of the pre-approved report-ready template, or empty when none is approved. */
  templateName: string | null;
  /** The template's approved language code, e.g. `en`. */
  language: string;
};

const shortError = (err: unknown): string => {
  if (err instanceof Error) return err.message.slice(0, 140);
  return String(err).slice(0, 140);
};

const GRAPH_VERSION = 'v21.0';

export type WhatsAppTransport = {
  /** False when the deployment has no Meta credentials; the queue then waits rather than dying. */
  configured: boolean;
  label: string;
  send(message: { to: string; params: string[] }): Promise<SendResult>;
};

export function createWhatsAppTransport(settings: WhatsAppSettings): WhatsAppTransport {
  if (!settings.token || !settings.phoneNumberId || !settings.templateName) {
    return {
      configured: false,
      label: 'not configured',
      async send(): Promise<SendResult> {
        return { ok: false, error: 'whatsapp_not_configured' };
      },
    };
  }

  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${settings.phoneNumberId}/messages`;
  return {
    configured: true,
    // The phone number id, never the token: this string lands in an audit row, and a credential
    // in the chain a regulator reads five years later is a leak no delivery is worth.
    label: `wa:${settings.phoneNumberId}`,
    async send(message): Promise<SendResult> {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            // The Cloud API takes the number bare — the `+` is E.164 dressing the queue stores,
            // and the digits alone are what identifies the recipient on the wire.
            to: message.to.replace(/\D/g, ''),
            type: 'template',
            template: {
              name: settings.templateName,
              language: { code: settings.language },
              components: [{
                type: 'body',
                parameters: message.params.map((text) => ({ type: 'text', text })),
              }],
            },
          }),
        });
        if (!res.ok) {
          // Meta's error body names the real problem (template not approved, recipient not on
          // WhatsApp, token expired) and is what an operator needs; it does not echo the token.
          const detail = (await res.text()).slice(0, 120);
          return { ok: false, error: `http_${res.status}: ${detail}` };
        }
        const payload = (await res.json()) as { messages?: { message_id?: string }[] };
        // As with SMTP: an acceptance that names no message id is not an acceptance. WhatsApp
        // echoes `messages[0].message_id` on success, and nothing on a silently dropped send.
        return payload.messages?.[0]?.message_id
          ? { ok: true }
          : { ok: false, error: 'no_message_id' };
      } catch (err) {
        return { ok: false, error: shortError(err) };
      }
    },
  };
}
