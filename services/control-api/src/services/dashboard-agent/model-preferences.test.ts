import { afterEach, expect, it, vi } from 'vitest';
import { readPersonalAssistantModel, readModelPreference, saveModelPreference } from './model-preferences.js';

afterEach(() => vi.unstubAllEnvs());

it('uses a personal default only for its authenticated user', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ model: 'vendor/personal' }] });
  expect(await readPersonalAssistantModel({ query } as any, 'user-one')).toBe('vendor/personal');
  expect(query.mock.calls[0][1]).toEqual(['user-one']);
});

it('falls back to the deployment default when no personal preference exists', async () => {
  vi.stubEnv('DASHBOARD_ASSISTANT_MODEL', 'vendor/platform');
  const query = vi.fn().mockResolvedValue({ rows: [{ model: null }] });
  expect(await readPersonalAssistantModel({ query } as any, 'user-one')).toBe('vendor/platform');
});

it('does not allow an organization nonmember to read its model', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await expect(readModelPreference({ query } as any, { userId: 'stranger', organizationId: 'other-org' })).rejects.toMatchObject({ statusCode: 403 });
  expect(query.mock.calls[0][1]).toEqual(['stranger', 'other-org']);
});

it('requires current owner membership within an organization model update', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await expect(saveModelPreference({ query } as any, { userId: 'member', organizationId: 'org' }, 'vendor/model')).rejects.toMatchObject({ statusCode: 403 });
  expect(query.mock.calls[0][0]).toContain("m.role='owner'");
  expect(query.mock.calls[0][1]).toEqual(['member', 'org', 'vendor/model']);
});

it('can clear a personal preference without changing anyone else', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ model: null }] });
  expect(await saveModelPreference({ query } as any, { userId: 'user-one' }, null)).toBeNull();
  expect(query.mock.calls[0][1]).toEqual(['user-one', null]);
});
