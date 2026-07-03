import type { Pool } from 'pg';
import { NotFoundError } from './api-errors.js';

/**
 * Resolve an api key's owning organization id from the control plane.
 * api_keys.organization_id is NOT NULL post Plan 07 migration 077, so a
 * present row always yields an org.
 */
export async function resolveOrgFromApiKey(controlPool: Pool, apiKeyId: string): Promise<string> {
  const result = await controlPool.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM api_keys WHERE id = $1',
    [apiKeyId],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('api_key', apiKeyId);
  }
  const orgId = result.rows[0].organization_id;
  if (!orgId) {
    throw new Error(`resolveOrgFromApiKey: api_key ${apiKeyId} has no organization_id`);
  }
  return orgId;
}
