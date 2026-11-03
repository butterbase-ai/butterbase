import { describe, it, expect } from 'vitest';
import { canReadOfficeActivity } from '../office-activity-access.js';
const conversation = { origin: 'office', organizationId: '11111111-1111-4111-8111-111111111111' };
const auth = { userId: 'user', authMethod: 'api_key' as const, keyId: 'key', scopes: ['*'] };
describe('current website preview authorization', () => {
  it.each([
    { revoked_at: new Date() }, { expires_at: new Date('2020-01-01') }, { scopes: [] }, { scopes: ['*','app:private'] },
    { organization_locked: true, organization_id: 'other' },
  ])('rejects a credential whose current saved restrictions changed: %j', change => {
    const pool = { query: async (sql: string) => ({ rows: sql.includes('organization_members') ? [{ role: 'owner' }] : [{ scopes: ['*'], ...change }] }) } as any;
    return expect(canReadOfficeActivity(pool, conversation, auth)).resolves.toBe(false);
  });
  it('requires current membership independently of JWT ownership or an organization header', async () => {
    const pool = { query: async () => ({ rows: [] }) } as any;
    expect(await canReadOfficeActivity(pool, conversation, { ...auth, authMethod: 'jwt' })).toBe(false);
  });
  it('keeps managed readers bound to the current owning organization and role', async () => {
    const pool = { query: async (sql: string) => ({ rows: sql.includes('organization_members') ? [{ role: 'member' }] : [{ scopes: ['*'], organization_locked: true, organization_id: conversation.organizationId }] }) } as any;
    expect(await canReadOfficeActivity(pool, conversation, auth)).toBe(false);
  });
  it('rejects app credentials even when they carry the initiating platform identity', async () => {
    expect(await canReadOfficeActivity({} as any, conversation, { ...auth, appId: 'app_private' })).toBe(false);
  });
});
