import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppTransport } from '../src/whatsapp.js';

const settings = (over: Partial<Parameters<typeof createWhatsAppTransport>[0]> = {}) => ({
  token: 'EAAG-permanent-token',
  phoneNumberId: '109876543210987',
  templateName: 'report_ready',
  language: 'en',
  ...over,
});

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(response: { status?: number; body?: unknown }) {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {})),
      json: async () => response.body ?? {},
    };
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWhatsAppTransport', () => {
  it('waits rather than dies when any credential is missing', async () => {
    for (const partial of [
      settings({ token: null }),
      settings({ phoneNumberId: null }),
      settings({ templateName: null }),
    ]) {
      const t = createWhatsAppTransport(partial);
      expect(t.configured).toBe(false);
      expect(await t.send({ to: '+919845012345', params: ['a', 'b', 'c', 'd'] }))
        .toEqual({ ok: false, error: 'whatsapp_not_configured' });
    }
  });

  it('posts the template message to the Cloud API with the parameters in order', async () => {
    const calls = fakeFetch({ body: { messages: [{ message_id: 'wamid.X' }] } });
    const t = createWhatsAppTransport(settings());
    const r = await t.send({
      to: '+919845012345',
      params: ['Sparsh Diagnostic Centre', 'ACC-REP-1', '2', 'https://telrad.example/portal'],
    });
    expect(r).toEqual({ ok: true });
    const call = calls[0];
    if (!call) throw new Error('expected one fetch');
    expect(call.url).toBe('https://graph.facebook.com/v21.0/109876543210987/messages');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer EAAG-permanent-token');
    const body = JSON.parse(String(call.init.body)) as {
      messaging_product: string;
      to: string;
      template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
    };
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('919845012345');
    expect(body.template.name).toBe('report_ready');
    expect(body.template.language.code).toBe('en');
    expect(body.template.components[0]?.parameters.map((p) => p.text)).toEqual([
      'Sparsh Diagnostic Centre', 'ACC-REP-1', '2', 'https://telrad.example/portal',
    ]);
  });

  it('treats an acceptance without a message id as a failure', async () => {
    fakeFetch({ body: { messaging_product: 'whatsapp', contacts: [{ input: '919845012345' }] } });
    const t = createWhatsAppTransport(settings());
    const r = await t.send({ to: '+919845012345', params: ['a', 'b', 'c', 'd'] });
    expect(r).toEqual({ ok: false, error: 'no_message_id' });
  });

  it('returns Meta’s error detail on a non-200 without echoing the token', async () => {
    fakeFetch({ status: 403, body: { error: { message: '(#200) template not approved', code: 200 } } });
    const t = createWhatsAppTransport(settings());
    const r = await t.send({ to: '+919845012345', params: ['a', 'b', 'c', 'd'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('http_403');
      expect(r.error).toContain('template not approved');
      expect(r.error).not.toContain('EAAG-permanent-token');
    }
  });

  it('labels itself by phone number id, never by token', () => {
    expect(createWhatsAppTransport(settings()).label).toBe('wa:109876543210987');
    expect(createWhatsAppTransport(settings()).label).not.toContain('EAAG');
  });
});
