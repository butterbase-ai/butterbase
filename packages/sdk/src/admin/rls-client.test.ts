import { describe, it, expect } from 'vitest';
import type { CreatePolicyParams } from './types';
import { AdminRlsClient } from './rls-client';

describe('CreatePolicyParams', () => {
  it('supports restrictive, role, user_column with optional command', () => {
    const p: CreatePolicyParams = {
      table_name: 't', policy_name: 'p', command: 'SELECT',
      role: 'user', restrictive: true, user_column: 'owner_id',
      using_expression: 'owner_id = auth.uid()',
    };
    expect(p.restrictive).toBe(true);
    expect(p.user_column).toBe('owner_id');
  });

  it('command is optional (backend defaults to ALL)', () => {
    const p: CreatePolicyParams = { table_name: 't', policy_name: 'p' };
    expect(p.command).toBeUndefined();
  });
});

describe('AdminRlsClient.createUserIsolation', () => {
  it('forwards public_read_column when provided', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({});
      },
    };
    const c = new AdminRlsClient(fakeClient);
    await c.createUserIsolation('posts', 'author_id', { publicReadColumn: 'is_public' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/app_x/rls',
      body: { table_name: 'posts', user_column: 'author_id', public_read_column: 'is_public' },
    });
  });

  it('omits public_read_column when not provided', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push(body); return Promise.resolve({}); },
    };
    await new AdminRlsClient(fakeClient).createUserIsolation('posts', 'author_id');
    expect(calls[0]).toEqual({ table_name: 'posts', user_column: 'author_id' });
  });
});

describe('AdminRlsClient.deletePolicy', () => {
  it('hits DELETE /v1/:app/rls/:table/:policy', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string) => {
        calls.push({ method, path });
        return Promise.resolve({});
      },
    };
    await new AdminRlsClient(fakeClient).deletePolicy('posts', 'p1');
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      path: '/v1/app_x/rls/posts/p1',
    });
  });
});

describe('AdminRlsClient.list normalization', () => {
  it('normalizes pg_policies snake keys (tablename/policyname/cmd/permissive/qual)', async () => {
    const fc: any = {
      appId: 'app_x',
      request: () => Promise.resolve([
        { tablename: 'posts', policyname: 'p1', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: ['user'], qual: 'true', with_check: null },
        { tablename: 'comments', policyname: 'p2', cmd: 'INSERT', permissive: 'RESTRICTIVE', roles: 'anon', qual: 'user_id IS NULL', with_check: 'user_id IS NULL' },
      ]),
    };
    const c = new AdminRlsClient(fc);
    const r = await c.list();
    expect(r.error).toBeNull();
    expect(r.data?.[0]).toEqual({
      table_name: 'posts', policy_name: 'p1', command: 'SELECT',
      role: 'user', restrictive: false,
      using_expression: 'true', with_check_expression: null,
    });
    expect(r.data?.[1].restrictive).toBe(true);
    expect(r.data?.[1].role).toBe('anon');
  });

  it('returns empty array when backend returns nothing', async () => {
    const fc: any = { appId: 'app_x', request: () => Promise.resolve(null) };
    const r = await new AdminRlsClient(fc).list();
    expect(r.data).toEqual([]);
  });

  it('passes through already-normalized rows unchanged', async () => {
    const fc: any = {
      appId: 'app_x',
      request: () => Promise.resolve([
        { table_name: 'posts', policy_name: 'p1', command: 'ALL', role: 'user', restrictive: true,
          using_expression: 'owner_id = auth.uid()', with_check_expression: null },
      ]),
    };
    const r = await new AdminRlsClient(fc).list();
    expect(r.data?.[0].restrictive).toBe(true);
    expect(r.data?.[0].command).toBe('ALL');
  });
});
