import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { verifyEndUserJwt } from '../end-user-auth.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
import { AppNotFoundError } from '../app-resolver.js';

/**
 * Identifies *who* made an authorized per-app AI call. Routes that persist
 * per-call state (notably `ai_video_jobs`) use this to scope visibility on
 * subsequent reads: end-users see only their own rows; owners and scoped
 * keys see every row in the app.
 */
export type AppAiCaller =
  | { kind: 'owner' }
  | { kind: 'end_user'; sub: string }
  | { kind: 'scoped_key' };

export type AppAiAuthResult =
  | { ok: true; ownerId: string; caller: AppAiCaller }
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
 * The `apps` table lives in the per-region runtime DB (post-cutover migration
 * 061), so the owner lookup resolves the app's home region first and queries
 * the runtime pool. Pass the control-plane pool — it's used for the
 * `user_app_index` lookup inside `getRuntimeDbForApp`.
 *
 * Returns `{ ok: true, ownerId }` on success, or a `{ status, body }` payload
 * the route handler should `reply.code(status).send(body)`.
 */
export async function authorizeAppAiCall(
  controlDb: Pool,
  appId: string,
  request: FastifyRequest,
): Promise<AppAiAuthResult> {
  let ownerId: string;
  try {
    const runtimePool = await getRuntimeDbForApp(controlDb, appId);
    const ownerResult = await runtimePool.query<{ owner_id: string }>(
      'SELECT owner_id FROM apps WHERE id = $1',
      [appId],
    );
    if (ownerResult.rows.length === 0) {
      return { ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } };
    }
    ownerId = ownerResult.rows[0].owner_id;
  } catch (err) {
    if (err instanceof AppNotFoundError) {
      return { ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } };
    }
    throw err;
  }

  const { userId, authMethod, scopes, rawToken } = request.auth;

  // 1. Direct ownership (platform JWT or owner-minted API key).
  // Only platform-credential auth methods can claim owner status by virtue of
  // userId === ownerId. Restricted-scope auth methods (e.g. function_key,
  // which carries the owner UUID for downstream attribution but is scoped
  // only to /integrations/execute) must NOT collect this grant — otherwise
  // a leaked FSK would drain the owner's AI credits.
  if (userId && userId === ownerId && (authMethod === 'api_key' || authMethod === 'jwt')) {
    return { ok: true, ownerId, caller: { kind: 'owner' } };
  }

  // 2. End-user JWT issued by this app
  if (authMethod === 'end_user_jwt' && rawToken) {
    try {
      const claims = await verifyEndUserJwt(controlDb, appId, rawToken);
      const sub = String(claims.sub ?? '');
      if (sub) {
        return { ok: true, ownerId, caller: { kind: 'end_user', sub } };
      }
      // No sub claim — treat as malformed and fall through.
    } catch {
      // Fall through to 403 — verification failed or signing key missing
    }
  }

  // 3. API key with explicit per-app scope (delegation). Bare `'*'` scope is
  // NOT treated as cross-app — it only means "full access for the key's own
  // user", which case (1) already covered. Without an explicit `app:<appId>`
  // grant we must not let a stranger's key drain the owner's credits.
  if (authMethod === 'api_key' && Array.isArray(scopes) && scopes.includes(`app:${appId}`)) {
    return { ok: true, ownerId, caller: { kind: 'scoped_key' } };
  }

  return { ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } };
}
