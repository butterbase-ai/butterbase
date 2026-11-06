import type pg from 'pg';
import type { AuthContext } from '@butterbase/shared';

/** Current authorization for newly exposed preview data, independent of a raw
 * organization header or an earlier conversation/capture authorization. */
export async function canReadOfficeActivity(pool: pg.Pool, conversation: { organizationId: string | null; origin: string }, auth: AuthContext): Promise<boolean> {
  if (!auth.userId || auth.appId || !['jwt','api_key'].includes(auth.authMethod)) return false;
  const organizationId = conversation.organizationId;
  if (conversation.origin !== 'office') return auth.authMethod === 'jwt';
  if (!organizationId) return false;
  const membership = await pool.query(`SELECT m.role FROM organization_members m JOIN platform_users u ON u.id=m.user_id
    WHERE m.organization_id=$1 AND m.user_id=$2`, [organizationId, auth.userId]);
  if (!membership.rows[0]) return false;
  if (auth.authMethod === 'jwt') return true;
  if (!auth.keyId) return false;
  const keys = await pool.query(`SELECT k.scopes,k.revoked_at,k.expires_at,to_jsonb(k)->>'organization_id' AS organization_id,
    COALESCE((to_jsonb(k)->>'organization_locked')::boolean,false) AS organization_locked
    FROM api_keys k WHERE k.id=$1 AND k.user_id=$2`, [auth.keyId, auth.userId]);
  const key = keys.rows[0];
  if (!key || key.revoked_at || (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) || !Array.isArray(key.scopes)
    || !key.scopes.includes('*') || key.scopes.some((scope: string) => scope.startsWith('app:'))) return false;
  return !key.organization_locked || (key.organization_id === organizationId && membership.rows[0].role === 'owner');
}
