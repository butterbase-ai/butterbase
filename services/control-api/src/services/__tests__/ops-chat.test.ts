import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendOpsChatMessage } from '../ops-chat.js';

const WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';

afterEach(() => {
  delete process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL;
});

describe('sendOpsChatMessage', () => {
  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn();
    const sent = await sendOpsChatMessage('anything', { fetchImpl });
    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the message as Google Chat JSON to the configured webhook', async () => {
    process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL = WEBHOOK;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    const sent = await sendOpsChatMessage('3 orgs under $1', { fetchImpl });

    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: '3 orgs under $1' });
  });

  it('reports failure without throwing when the webhook returns non-2xx', async () => {
    process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL = WEBHOOK;
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    await expect(sendOpsChatMessage('hi', { fetchImpl })).resolves.toBe(false);
  });

  it('reports failure without throwing when the request itself throws', async () => {
    process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL = WEBHOOK;
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(sendOpsChatMessage('hi', { fetchImpl })).resolves.toBe(false);
  });

  it('never puts the webhook URL in a thrown or logged message', async () => {
    // The URL embeds `key` and `token` query params and is a bearer secret:
    // anyone holding it can post into the space. A failure path that echoes
    // it leaks the secret into logs.
    process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL = WEBHOOK;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await sendOpsChatMessage('hi', { fetchImpl });
    spy.mockRestore();
    expect(JSON.stringify(errors)).not.toContain('token=t');
    expect(JSON.stringify(errors)).not.toContain('key=k');
  });
});
