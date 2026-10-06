import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendBillingEmail, redis } = vi.hoisted(() => ({
  sendBillingEmail: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn() },
}));

vi.mock('../auth/email-service.js', () => ({ sendBillingEmail }));
vi.mock('../redis.js', () => ({ getRedisClient: () => redis }));
vi.mock('../notification-prefs.service.js', () => ({ createActionToken: vi.fn() }));

import { notifyCloneFailed } from '../failure-notifications.service.js';

function pools(appRow: Record<string, unknown> | null, email: string | null) {
  const runtimePool = { query: vi.fn().mockResolvedValue({ rows: appRow ? [appRow] : [] }) };
  const controlPool = { query: vi.fn().mockResolvedValue({ rows: email ? [{ email }] : [] }) };
  return { runtimePool: runtimePool as never, controlPool: controlPool as never };
}

const args = { appId: 'app_abc', jobId: 'job_1', sourceAppId: 'app_tpl', errorMessage: 'boom', mode: 'clone' as const };

describe('notifyCloneFailed', () => {
  beforeEach(() => {
    sendBillingEmail.mockReset().mockResolvedValue('sent');
    redis.set.mockReset().mockResolvedValue('OK');
    redis.del.mockReset().mockResolvedValue(1);
  });

  it('sends ops its own template with org + owner, and the owner the customer template', async () => {
    const { controlPool, runtimePool } = pools({ owner_id: 'u1', app_name: 'Pantry', organization_id: 'org_9' }, 'owner@example.com');
    await notifyCloneFailed(controlPool, runtimePool, args);

    const templates = sendBillingEmail.mock.calls.map((c) => c[1]);
    expect(templates).toEqual(['clone_failed_ops', 'clone_failed']);
    const opsData = sendBillingEmail.mock.calls[0][2];
    expect(opsData).toMatchObject({ appName: 'Pantry', organizationId: 'org_9', ownerEmail: 'owner@example.com', jobId: 'job_1' });
    expect(sendBillingEmail.mock.calls[1][0]).toBe('owner@example.com');
  });

  it('still alerts ops when the app has no owner', async () => {
    const { controlPool, runtimePool } = pools(null, null);
    await notifyCloneFailed(controlPool, runtimePool, args);
    expect(sendBillingEmail).toHaveBeenCalledOnce();
    expect(sendBillingEmail.mock.calls[0][1]).toBe('clone_failed_ops');
    expect(sendBillingEmail.mock.calls[0][2]).toMatchObject({ ownerEmail: '', organizationId: '' });
  });
});
