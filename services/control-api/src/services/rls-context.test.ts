import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { executeWithRole } from './rls-context.js';

const query = vi.fn();
const release = vi.fn();
const client = { query, release } as unknown as PoolClient;
const connect = vi.fn();
const pool = { connect } as unknown as Pool;

beforeEach(() => {
  vi.resetAllMocks();
  connect.mockResolvedValue(client);
  query.mockResolvedValue({ rows: [] });
});

describe('executeWithRole transaction boundary', () => {
  it('establishes the user context before executing customer SQL and returns its result', async () => {
    const value = await executeWithRole(pool, 'butterbase_user', "user'quoted", async c => {
      expect(query.mock.calls.map(call => call[0])).toEqual([
        'BEGIN', 'SET LOCAL ROLE butterbase_user', "SET LOCAL app.role = 'butterbase_user'",
        "SET LOCAL request.jwt.claim.sub = 'user''quoted'",
      ]);
      expect(c).toBe(client);
      await c.query('SELECT customer_data');
      return { retained: true };
    });
    expect(value).toEqual({ retained: true });
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(['butterbase_anon', 'butterbase_service'] as const)('%s does not inherit the supplied user claim', async role => {
    await executeWithRole(pool, role, 'ignored-user', async c => c.query('SELECT customer_data'));
    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', `SET LOCAL ROLE ${role}`, `SET LOCAL app.role = '${role}'`, 'SELECT customer_data', 'COMMIT',
    ]);
  });

  it.each(['BEGIN', 'SET LOCAL ROLE butterbase_user', "SET LOCAL app.role = 'butterbase_user'", "SET LOCAL request.jwt.claim.sub = 'user-a'"])(
    'does not execute customer SQL when context setup fails at %s', async failingSql => {
      const error = new Error('context setup failed');
      query.mockImplementation(async sql => { if (sql === failingSql) throw error; return { rows: [] }; });
      const callback = vi.fn();
      await expect(executeWithRole(pool, 'butterbase_user', 'user-a', callback)).rejects.toBe(error);
      expect(callback).not.toHaveBeenCalled();
      expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['callback', 'commit'])('rolls back and releases on %s failure', async stage => {
    const error = new Error('customer transaction failed');
    if (stage === 'commit') query.mockImplementation(async sql => { if (sql === 'COMMIT') throw error; return { rows: [] }; });
    await expect(executeWithRole(pool, 'butterbase_user', 'user-a', async () => {
      if (stage === 'callback') throw error;
      return 'ok';
    })).rejects.toBe(error);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not claim to execute a transaction if acquiring the client fails', async () => {
    const error = new Error('pool unavailable');
    connect.mockRejectedValue(error);
    const callback = vi.fn();
    await expect(executeWithRole(pool, 'butterbase_user', 'user-a', callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
