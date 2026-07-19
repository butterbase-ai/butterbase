import { Pool } from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';

/**
 * Resolve the app's home region from the cross-region org_app_index on
 * the control DB. Returns null when the app isn't indexed. Callers that
 * need the per-region runtime DB should look up the region here first.
 */
async function resolveHomeRegion(controlPool: Pool, appId: string): Promise<string | null> {
  const r = await controlPool.query<{ region: string }>(
    `SELECT region FROM org_app_index WHERE app_id = $1`,
    [appId]
  );
  return r.rows[0]?.region ?? null;
}

export class AppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App not found: ${appId}`);
    this.name = 'AppNotFoundError';
  }
}

export class AppAuthRequiredError extends Error {
  constructor(appId: string) {
    super(`App ${appId} requires authentication`);
    this.name = 'AppAuthRequiredError';
  }
}

export class AppPausedError extends Error {
  reason: string | null;
  constructor(appId: string, reason: string | null) {
    super(`App ${appId} is paused${reason ? `: ${reason}` : ''}`);
    this.name = 'AppPausedError';
    this.reason = reason;
  }
}

interface PausableApp {
  id: string;
  paused?: boolean;
  paused_reason?: string | null;
}

/**
 * Throws AppPausedError if the resolved app has been paused via the
 * pause_app kill-switch. Call this in data-plane entry points right after
 * AppResolver.resolveApp / resolveAppPublic. Control-plane endpoints (config
 * mutations, the unpause toggle) intentionally do not call this.
 */
export function assertAppNotPaused(app: PausableApp): void {
  if (app.paused) {
    throw new AppPausedError(app.id, app.paused_reason ?? null);
  }
}

export class AppResolver {
  /**
   * Resolve an app by ID with ownership check
   * Throws AppNotFoundError if app doesn't exist or user doesn't own it
   */
  static async resolveApp(
    controlPool: Pool,
    appId: string,
    userId: string,
    /**
     * Optional: the caller's ACTIVE organization scope. When set (bb_sk_*
     * API-key path or JWT session with x-organization-id header), access is
     * restricted to apps in this exact org — even if the user is a member of
     * other orgs that own the app. Enforces the Plan 07 strict per-key-org
     * scoping model.
     *
     * When omitted (legacy JWT sessions without an active-org signal), falls
     * back to the membership-enumeration check for backwards compatibility.
     */
    activeOrganizationId?: string | null,
  ): Promise<{ id: string; name: string; owner_id: string; db_name: string; paused: boolean; paused_reason: string | null }> {
    const region = await resolveHomeRegion(controlPool, appId);
    if (!region) throw new AppNotFoundError(appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimeDb.query<{
      id: string;
      name: string;
      owner_id: string;
      organization_id: string | null;
      db_name: string;
      paused: boolean;
      paused_reason: string | null;
    }>(
      `SELECT id, name, owner_id, organization_id, db_name, paused, paused_reason
       FROM apps
       WHERE id = $1`,
      [appId]
    );

    if (result.rows.length === 0) {
      throw new AppNotFoundError(appId);
    }
    const row = result.rows[0];

    // Auth resolves in this order:
    //   1. app in caller's active org  → allow (fast path for bb_sk_* keys)
    //   2. caller is the app's owner   → allow
    //   3. caller is a member of the app's org → allow
    //   4. otherwise → 404
    //
    // Rationale for step 3 even when activeOrganizationId is set: an unscoped
    // JWT session (no x-organization-id) already sees every app in every org
    // the user belongs to via steps 2/3. Denying the same user when they call
    // with a personal-org bb_sk_* key or a JWT with x-organization-id set to a
    // different org creates an inconsistency where credential type — not
    // identity — decides access. It also creates chicken-and-egg pain: an
    // MCP session cannot discover team-org app ids without switching org
    // context, but the strict-scoped list can't return them either.
    //
    // Scoped API keys (bb_sk_* with a restricted scope) still gate WRITES
    // through the org_scoping model documented in the api-key service; this
    // resolver decides which app a caller can address, not what they can do.

    if (activeOrganizationId && row.organization_id && row.organization_id === activeOrganizationId) {
      return row;
    }

    if (row.owner_id === userId) return row;

    if (row.organization_id) {
      const member = await controlPool.query(
        `SELECT 1 FROM organization_members
         WHERE organization_id = $1 AND user_id = $2
         LIMIT 1`,
        [row.organization_id, userId]
      );
      if (member.rows.length > 0) return row;
    }

    throw new AppNotFoundError(appId);
  }

  /**
   * Resolve an app by ID without ownership check (for anonymous/public access)
   * Throws AppNotFoundError if app doesn't exist or isn't provisioned
   */
  static async resolveAppPublic(
    controlPool: Pool,
    appId: string
  ): Promise<{ id: string; db_name: string; access_mode: string; paused: boolean; paused_reason: string | null }> {
    const region = await resolveHomeRegion(controlPool, appId);
    if (!region) throw new AppNotFoundError(appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimeDb.query(
      `SELECT id, db_name, access_mode, paused, paused_reason
       FROM apps
       WHERE id = $1 AND db_provisioned = true`,
      [appId]
    );

    if (result.rows.length === 0) {
      throw new AppNotFoundError(appId);
    }

    return result.rows[0];
  }
}
