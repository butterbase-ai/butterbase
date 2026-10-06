import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const prefs = vi.hoisted(() => ({
  consumeActionToken: vi.fn(),
  peekActionToken: vi.fn(),
  snoozeFunctionFor24h: vi.fn(),
  muteFunction: vi.fn(),
  unsubscribeFromTemplate: vi.fn(),
  disableDigest: vi.fn(),
}));
vi.mock('../services/notification-prefs.service.js', () => prefs);

import { notificationActionsRoutes } from './notification-actions.js';

const TOKEN = 'a'.repeat(43);
const URL = `/v1/notif/action/${TOKEN}`;

async function build() {
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  await app.register(notificationActionsRoutes);
  await app.ready();
  return app;
}

describe('notification action links', () => {
  beforeEach(() => {
    for (const fn of Object.values(prefs)) fn.mockReset();
  });

  it('GET shows a confirmation form and never consumes the token', async () => {
    prefs.peekActionToken.mockResolvedValue({ userId: 'u1', action: 'mute_function', payload: { functionId: 'f1' } });
    const app = await build();
    const r = await app.inject({ method: 'GET', url: URL });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<form method="post"');
    expect(r.body).toContain('Mute function');
    expect(prefs.consumeActionToken).not.toHaveBeenCalled();
    expect(prefs.muteFunction).not.toHaveBeenCalled();
    expect(String(r.headers['content-security-policy'])).toContain("form-action 'self'");
    await app.close();
  });

  it('GET of an unknown or used token is 410', async () => {
    prefs.peekActionToken.mockResolvedValue(null);
    const app = await build();
    const r = await app.inject({ method: 'GET', url: URL });
    expect(r.statusCode).toBe(410);
    await app.close();
  });

  it('POST from the confirm button consumes the token and applies the action', async () => {
    prefs.consumeActionToken.mockResolvedValue({ userId: 'u1', action: 'snooze_function_24h', payload: { functionId: 'f1' } });
    const app = await build();
    const r = await app.inject({
      method: 'POST', url: URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'confirm=1',
    });
    expect(r.statusCode).toBe(200);
    expect(prefs.snoozeFunctionFor24h).toHaveBeenCalledWith({}, 'u1', 'f1');
    await app.close();
  });

  it('accepts an RFC 8058 one-click POST (multipart) without a confirm page', async () => {
    prefs.consumeActionToken.mockResolvedValue({ userId: 'u1', action: 'unsubscribe_template', payload: { template: 'function_failed' } });
    const app = await build();
    const boundary = 'xyz';
    const r = await app.inject({
      method: 'POST', url: URL,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`,
    });
    expect(r.statusCode).toBe(200);
    expect(prefs.unsubscribeFromTemplate).toHaveBeenCalledWith({}, 'u1', 'function_failed');
    await app.close();
  });

  it('a digest unsubscribe turns the digest off instead of silencing the template', async () => {
    prefs.consumeActionToken.mockResolvedValue({ userId: 'u1', action: 'unsubscribe_template', payload: { template: 'weekly_digest' } });
    const app = await build();
    const r = await app.inject({
      method: 'POST', url: URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(r.statusCode).toBe(200);
    expect(prefs.disableDigest).toHaveBeenCalledWith({}, 'u1');
    expect(prefs.unsubscribeFromTemplate).not.toHaveBeenCalled();
    await app.close();
  });
});
