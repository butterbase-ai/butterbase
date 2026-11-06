import type { Pool } from 'pg';
import type { AuthContext } from '@butterbase/shared/types';
import { AuthorizationError } from './api-errors.js';
import { ApiKeyService } from './api-key-service.js';
import { AppResolver } from './app-resolver.js';

const sameOrg = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

/** Fresh authority check: never use cached owner membership or key validity. */
export async function assertLockedKeyTarget(
  controlDb: Pool,
  auth: AuthContext,
  target: { organizationId?: string; appIds?: string[] },
): Promise<void> {
  if (!auth.organizationLocked) return;
  const deny = () => new AuthorizationError('Managed key is unavailable or outside its organization', 'AUTH_ORG_FORBIDDEN');
  if (!auth.organizationId || !auth.userId || !auth.keyId) throw deny();
  if (target.organizationId !== undefined && !sameOrg(target.organizationId, auth.organizationId)) throw deny();
  const current = await controlDb.query(
    `SELECT k.id FROM api_keys k
     JOIN platform_users u ON u.id = k.user_id
     JOIN organization_members m ON m.user_id = u.id AND m.organization_id = k.organization_id AND m.role = 'owner'
     WHERE k.id = $1 AND k.user_id = $2 AND k.organization_id = $3
       AND k.organization_locked = true AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [auth.keyId, auth.userId, auth.organizationId],
  );
  if (current.rows.length === 0) throw deny();
  await Promise.all([...new Set(target.appIds ?? [])].map((appId) =>
    AppResolver.resolveApp(controlDb, appId, auth.userId!, auth.organizationId, { strictOrganization: true }),
  ));
}

/** Target fields in HTTP payloads and MCP/operator arguments (never infer ownership from user identity). */
export async function assertLockedKeyArguments(controlDb: Pool, auth: AuthContext, args: unknown): Promise<void> {
  if (!auth.organizationLocked) return;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const appIds: string[] = [];
  const orgFields = new Set(['organizationId', 'organization_id', 'org_id', 'orgId', 'substrate_organization_id', 'target_organization_id', 'destination_organization_id']);
  const appFields = new Set(['appId', 'app_id', 'target_app_id', 'targetAppId', 'source_app_id', 'sourceAppId', 'dest_app_id', 'destAppId']);
  for (const [key, value] of Object.entries(args)) {
    if (orgFields.has(key) && value !== undefined) {
      if (typeof value !== 'string' || !auth.organizationId || !sameOrg(value, auth.organizationId)) {
        throw new AuthorizationError('Managed key cannot override its organization', 'AUTH_ORG_FORBIDDEN');
      }
    }
    if (appFields.has(key) && value !== undefined) {
      if (typeof value !== 'string' || !value) throw new AuthorizationError('Invalid managed key app target', 'AUTH_ORG_FORBIDDEN');
      appIds.push(value);
    }
    if ((key === 'app_ids' || key === 'appIds') && value !== undefined) {
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
        throw new AuthorizationError('Invalid managed key app targets', 'AUTH_ORG_FORBIDDEN');
      }
      appIds.push(...value);
    }
  }
  await assertLockedKeyTarget(controlDb, auth, { appIds });
}

/** Operator in-process tools must enforce the same key boundary as HTTP tools. */
export async function assertOperatorKeyArguments(controlDb: Pool, token: string, organizationId: string | null, args: unknown): Promise<void> {
  if (!token.startsWith('bb_sk_')) return;
  const auth = await ApiKeyService.validateApiKey(controlDb, token);
  if (!auth) throw new AuthorizationError('Invalid operator credential', 'AUTH_ORG_FORBIDDEN');
  if (!auth.organizationLocked) return;
  await assertLockedKeyTarget(controlDb, auth, { organizationId: organizationId ?? '' });
  await assertLockedKeyArguments(controlDb, auth, args);
}
