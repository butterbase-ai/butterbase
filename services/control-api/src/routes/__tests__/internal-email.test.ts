import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

// Mock email-service so we don't need SES credentials in tests
vi.mock('../../services/auth/email-service.js', () => ({
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import { internalEmailRoutes } from '../internal-email.js';
import { sendInviteEmail } from '../../services/auth/email-service.js';

// config.internal.emailSecret is evaluated at module load time (defaulting to
// 'dev-internal-email-secret' when INTERNAL_EMAIL_SECRET is unset in the test
// environment). We must match that default in tests — setting env vars after
// module load doesn't retroactively change the config object.
const SECRET = 'dev-internal-email-secret';

const VALID_BODY = {
  toEmail: 'alice@example.com',
  orgName: 'Acme',
  inviterEmail: 'bob@example.com',
  inviteUrl: 'https://dash.butterbase.ai/invite/abc',
  expiresAt: new Date('2026-08-01T00:00:00Z').toISOString(),
};

describe('POST /internal/email/invite', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(internalEmailRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 when X-Internal-Secret is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/internal/email/invite',
      payload: VALID_BODY,
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 when X-Internal-Secret is wrong', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/internal/email/invite',
      headers: { 'x-internal-secret': 'wrong-secret' },
      payload: VALID_BODY,
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 202 and fires email when secret is correct', async () => {
    vi.mocked(sendInviteEmail).mockClear();
    const r = await app.inject({
      method: 'POST',
      url: '/internal/email/invite',
      headers: { 'x-internal-secret': SECRET },
      payload: VALID_BODY,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ queued: true });
    // Give microtasks time to run (fire-and-forget is void, not awaited)
    await new Promise((res) => setTimeout(res, 10));
    expect(sendInviteEmail).toHaveBeenCalledOnce();
    expect(vi.mocked(sendInviteEmail).mock.calls[0][0]).toMatchObject({
      toEmail: 'alice@example.com',
      orgName: 'Acme',
      inviterEmail: 'bob@example.com',
    });
  });

  it('returns 400 when required field is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/internal/email/invite',
      headers: { 'x-internal-secret': SECRET },
      payload: { toEmail: 'a@b.com' }, // missing required fields
    });
    expect(r.statusCode).toBe(400);
  });
});
