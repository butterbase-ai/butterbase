import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authorizeAppAiCall } from './authorize-app-call.js';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';

vi.mock('../end-user-auth.js', () => ({
  verifyEndUserJwt: vi.fn(),
}));

vi.mock('../region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

vi.mock('../app-resolver.js', () => ({
  AppNotFoundError: class AppNotFoundError extends Error {
    constructor(appId: string) {
      super(`app not found: ${appId}`);
      this.name = 'AppNotFoundError';
    }
  },
  AppResolver: {
    resolveApp: vi.fn(),
  },
}));

import { verifyEndUserJwt } from '../end-user-auth.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
import { AppNotFoundError, AppResolver } from '../app-resolver.js';
const mockedVerify = verifyEndUserJwt as ReturnType<typeof vi.fn>;
const mockedResolve = getRuntimeDbForApp as ReturnType<typeof vi.fn>;
const mockedResolveApp = AppResolver.resolveApp as ReturnType<typeof vi.fn>;

const APP_ID = 'app_target';
const OWNER_ID = 'owner-uuid';
const OTHER_ID = 'someone-else';

function makeDb(ownerRow?: { owner_id: string } | null): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: ownerRow ? [ownerRow] : [] }),
  } as unknown as Pool;
}

function makeReq(auth: Partial<FastifyRequest['auth']>): FastifyRequest {
  return {
    auth: {
      userId: null,
      authMethod: 'anonymous',
      scopes: [],
      ...auth,
    },
  } as unknown as FastifyRequest;
}

describe('authorizeAppAiCall', () => {
  beforeEach(() => {
    mockedVerify.mockReset();
    mockedResolve.mockReset();
    mockedResolveApp.mockReset();
    // Default: resolver returns whatever `db` the test built — keeps the
    // existing `db.query` mock in the per-test setup as the source of truth
    // for the `apps` row.
    mockedResolve.mockImplementation(async (db: Pool) => db);
    // Default: caller is not an org member — AppResolver throws AppNotFoundError.
    mockedResolveApp.mockRejectedValue(new AppNotFoundError(APP_ID));
  });

  it('returns 404 when the app does not exist in the runtime DB', async () => {
    const db = makeDb(null);
    const req = makeReq({ userId: OWNER_ID, authMethod: 'jwt' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } });
  });

  it('returns 404 when the app has no user_app_index entry (AppNotFoundError)', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    mockedResolve.mockRejectedValueOnce(new AppNotFoundError(APP_ID));
    const req = makeReq({ userId: OWNER_ID, authMethod: 'jwt' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } });
  });

  it('allows the owner via platform JWT', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OWNER_ID, authMethod: 'jwt', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'owner' } });
  });

  it('allows the owner via bb_sk_* API key with `*` scope', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OWNER_ID, authMethod: 'api_key', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'owner' } });
  });

  it('allows an org member via platform JWT (billing stays on owner)', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    // AppResolver succeeds → caller is an org member
    mockedResolveApp.mockResolvedValueOnce({ id: APP_ID, owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'jwt', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'owner' } });
  });

  it('allows an org member via API key (billing stays on owner)', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    mockedResolveApp.mockResolvedValueOnce({ id: APP_ID, owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'api_key', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'owner' } });
  });

  it('rejects a different platform user with `*` scope (the original bug)', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'jwt', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('rejects a different platform user with API key + `*` scope', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'api_key', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('allows a third-party API key with explicit `app:<appId>` scope', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'api_key', scopes: [`app:${APP_ID}`] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'scoped_key' } });
  });

  it('rejects an API key scoped to a different app', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OTHER_ID, authMethod: 'api_key', scopes: ['app:app_other'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('allows an end-user JWT when verification succeeds against this app', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    mockedVerify.mockResolvedValueOnce({ sub: 'end-user-1' });
    const req = makeReq({ userId: '', authMethod: 'end_user_jwt', rawToken: 'tok' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID, caller: { kind: 'end_user', sub: 'end-user-1' } });
    expect(mockedVerify).toHaveBeenCalledWith(db, APP_ID, 'tok');
  });

  it('rejects an end-user JWT with empty/missing `sub`', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    mockedVerify.mockResolvedValueOnce({ sub: '' });
    const req = makeReq({ userId: '', authMethod: 'end_user_jwt', rawToken: 'tok' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('rejects an end-user JWT whose verification fails (e.g. wrong app or expired)', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    mockedVerify.mockRejectedValueOnce(new Error('bad signature'));
    const req = makeReq({ userId: '', authMethod: 'end_user_jwt', rawToken: 'tok' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('rejects an end-user JWT context with no rawToken', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: '', authMethod: 'end_user_jwt' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('rejects an anonymous request', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: null, authMethod: 'anonymous' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
  });

  it('rejects function_key even when userId aliases the owner (no owner-by-userId-aliasing)', async () => {
    // function_key sets auth.userId = owner_id for downstream attribution,
    // but the AI gateway authorizer must NOT treat that as owner-grade access.
    // Otherwise a leaked FSK would drain the owner's AI credits.
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OWNER_ID, authMethod: 'function_key', scopes: ['integrations:execute'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } });
    if (r.ok) throw new Error('unreachable');
  });
});
