import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { verifyEndUserJwt } from '../end-user-auth.js';

export type AppAiAuthResult =
  | { ok: true; ownerId: string }
  | { ok: false; status: number; body: { error: string; code: string } };

/**
 * Authorize a call to a per-app AI route (`/v1/:appId/chat/completions`,
 * `/embeddings`, `/videos/completions`) and resolve the billing identity.
 *
 * These routes always bill the **app owner**, not the caller, so that:
 *   - End-users of a deployed app can use its AI features without ever
 *     touching their own (non-existent) butterbase credit pool, and
 *   - A different platform user (e.g. a teammate or a stranger) can't drain
 *     their own credits by calling another developer's app.
 *
 * Authorization is granted if any of the following is true:
 *   1. The caller's platform user_id matches the app's owner_id. Covers both
 *      direct Cognito/local JWT sessions and `bb_sk_*` API keys minted by the
 *      owner (since those resolve `auth.userId` to the key's owning user).
 *   2. The caller presented an end-user JWT (`iss = butterbase:app:<appId>`)
 *      that verifies against the app's active signing key. The end-user's
 *      identity is irrelevant for billing — the owner still pays.
 *   3. The caller's API key has an explicit `app:<appId>` scope. This is the
 *      delegation path: a developer can mint a scoped key for a third-party
 *      integrator and the integrator's calls still bill the app owner.
 *
 * Returns `{ ok: true, ownerId }` on success, or a `{ status, body }` payload
 * the route handler should `reply.code(status).send(body)`.
 */
export async function authorizeAppAiCall(
  controlDb: Pool,
  appId: string,
  request: FastifyRequest,
): Promise<AppAiAuthResult> {
  const ownerResult = await controlDb.query<{ owner_id: string }>(
    'SELECT owner_id FROM apps WHERE id = $1',
    [appId],
  );
  if (ownerResult.rows.length === 0) {
    return { ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } };
  }
  const ownerId = ownerResult.rows[0].owner_id;

  const { userId, authMethod, scopes, rawToken } = request.auth;

  // 1. Direct ownership (platform JWT or owner-minted API key)
  if (userId && userId === ownerId) {
    return { ok: true, ownerId };
  }

  // 2. End-user JWT issued by this app
  if (authMethod === 'end_user_jwt' && rawToken) {
    try {
      await verifyEndUserJwt(controlDb, appId, rawToken);
      return { ok: true, ownerId };
    } catch {
      // Fall through to 403 — verification failed or signing key missing
    }
  }

  // 3. API key with explicit per-app scope (delegation). Bare `'*'` scope is
  // NOT treated as cross-app — it only means "full access for the key's own
  // user", which case (1) already covered. Without an explicit `app:<appId>`
  // grant we must not let a stranger's key drain the owner's credits.
  if (authMethod === 'api_key' && Array.isArray(scopes) && scopes.includes(`app:${appId}`)) {
    return { ok: true, ownerId };
  }

  return { ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } };
}
