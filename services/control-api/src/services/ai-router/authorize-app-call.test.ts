import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authorizeAppAiCall } from './authorize-app-call.js';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';

vi.mock('../end-user-auth.js', () => ({
  verifyEndUserJwt: vi.fn(),
}));

import { verifyEndUserJwt } from '../end-user-auth.js';
const mockedVerify = verifyEndUserJwt as ReturnType<typeof vi.fn>;

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
  });

  it('returns 404 when the app does not exist', async () => {
    const db = makeDb(null);
    const req = makeReq({ userId: OWNER_ID, authMethod: 'jwt' });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: false, status: 404, body: { error: 'app_not_found', code: 'APP_NOT_FOUND' } });
  });

  it('allows the owner via platform JWT', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OWNER_ID, authMethod: 'jwt', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID });
  });

  it('allows the owner via bb_sk_* API key with `*` scope', async () => {
    const db = makeDb({ owner_id: OWNER_ID });
    const req = makeReq({ userId: OWNER_ID, authMethod: 'api_key', scopes: ['*'] });
    const r = await authorizeAppAiCall(db, APP_ID, req);
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID });
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
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID });
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
    expect(r).toEqual({ ok: true, ownerId: OWNER_ID });
    expect(mockedVerify).toHaveBeenCalledWith(db, APP_ID, 'tok');
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
});
