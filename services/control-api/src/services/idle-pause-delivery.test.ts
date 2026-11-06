import { beforeEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn(async () => 'sent'));
const token = vi.hoisted(() => vi.fn(async () => 'unsubscribe-token'));
vi.mock('./auth/email-service.js', () => ({ sendBillingEmail: send }));
vi.mock('./notification-prefs.service.js', () => ({ createActionToken: token }));
const { sendIdlePauseEmail, sendIdlePauseBreakerEmail } = await import('./idle-pause-emails.js');
const app = { id: 'app_1', name: 'Pantry', organization_id: 'org_team' };
const log = { warn: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it('notifies all org owners with recipient preferences and unsubscribe headers', async () => {
  const db = { query: vi.fn(async () => ({ rows: [{ id: 'owner1', email: 'one@example.test' }, { id: 'owner2', email: 'two@example.test' }] })) };
  await sendIdlePauseEmail(db as never, app, 'project_idle_warning', 7, log);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("om.role = 'owner'"), ['org_team']);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledWith('two@example.test', 'project_idle_warning',
    { appId: 'app_1', appName: 'Pantry', organizationId: 'org_team', warnDays: '7' },
    { userId: 'owner2', controlPool: db, scope: { appId: 'app_1' }, actionTokens: { unsubscribeTemplate: 'unsubscribe-token' } });
});
it('delivers the reminder to owners with its configured lead time and unsubscribe scope', async () => {
  const db = { query: vi.fn(async () => ({ rows: [{ id: 'owner1', email: 'one@example.test' }] })) };
  await sendIdlePauseEmail(db as never, app, 'project_idle_reminder', 3, log);
  expect(send).toHaveBeenCalledWith('one@example.test', 'project_idle_reminder',
    { appId: 'app_1', appName: 'Pantry', organizationId: 'org_team', warnDays: '3' },
    expect.objectContaining({ userId: 'owner1', scope: { appId: 'app_1' }, actionTokens: { unsubscribeTemplate: 'unsubscribe-token' } }));
});
it('keeps delivering when one recipient or token mint fails', async () => {
  const db = { query: vi.fn(async () => ({ rows: [{ id: 'u1', email: 'one@example.test' }, { id: 'u2', email: 'two@example.test' }] })) };
  token.mockRejectedValueOnce(new Error('token unavailable'));
  send.mockRejectedValueOnce(new Error('mail unavailable'));
  await expect(sendIdlePauseEmail(db as never, app, 'project_paused_idle', 7, log)).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2); expect(log.warn).toHaveBeenCalled();
});
it('sends breaker alerts only to the configured ops address', async () => {
  await sendIdlePauseBreakerEmail(26, 100, log);
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.test');
  await sendIdlePauseBreakerEmail(26, 100, log);
  expect(send).toHaveBeenCalledWith('ops@example.test', 'idle_pause_breaker_ops', { count: '26', freeApps: '100' });
});
