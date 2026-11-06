import { describe, it, expect, vi } from 'vitest';
import { AppResolver } from './app-resolver.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const { runtime } = vi.hoisted(() => ({ runtime: { query: vi.fn() } }));
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: () => runtime }));
const db = { query: vi.fn(async () => ({ rows: [{ region: 'local' }] })) } as any;
describe('strict organization app resolution', () => {
  it.each([B, null])('rejects direct-owner fallback for app org %s', async (organization_id) => {
    runtime.query.mockResolvedValue({ rows: [{ id: 'app_b', owner_id: 'owner', organization_id }] });
    await expect(AppResolver.resolveApp(db, 'app_b', 'owner', A, { strictOrganization: true })).rejects.toThrow('App not found');
  });
  it('preserves ordinary direct-owner access across organizations', async () => {
    runtime.query.mockResolvedValue({ rows: [{ id: 'app_b', owner_id: 'owner', organization_id: B }] });
    await expect(AppResolver.resolveApp(db, 'app_b', 'owner', A)).resolves.toMatchObject({ id: 'app_b' });
  });
});
