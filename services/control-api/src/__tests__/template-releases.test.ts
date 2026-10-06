import { describe, it, expect, vi } from 'vitest';
import { summarizeRelease } from '../services/template-releases.js';

describe('summarizeRelease', () => {
  const full = {
    id: 'rel_abc', source_app_id: 'app_src', release_number: 3,
    label: 'v1.2.0', snapshot_id: 'snap_x', notes: 'adds rate limiting',
    published_by: 'usr_1', published_at: new Date('2026-08-27T00:00:00Z'),
    manifest: {
      schema: { tables: { todos: { columns: {} }, users: { columns: {} } } },
      rls: [], durable_objects: [],
      functions: [{ name: 'webhook', code: 'SECRET_BODY_SHOULD_NOT_LEAK' }],
      config: {}, snapshot_id: 'snap_x',
      required_env: { functions: { webhook: ['STRIPE_KEY'] }, durable_objects: [] },
      hashes: { schema: 'h1', rls: 'h2', functions: 'h3', config: 'h4' },
    },
  } as any;

  it('exposes counts, function names, and required env keys', () => {
    const s = summarizeRelease(full);
    expect(s.release_number).toBe(3);
    expect(s.table_count).toBe(2);
    expect(s.function_names).toEqual(['webhook']);
    expect(s.required_env).toEqual(['STRIPE_KEY']);
  });

  it('never exposes function bodies', () => {
    expect(JSON.stringify(summarizeRelease(full))).not.toContain('SECRET_BODY_SHOULD_NOT_LEAK');
  });
});

describe('publishRelease', () => {
  it('assigns release_number under an advisory lock and updates the runtime pointer', async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.trim().split('\n')[0]);
        if (sql.includes('MAX(release_number)')) return { rows: [{ max: 4 }] };
        if (sql.includes('INSERT INTO template_releases')) {
          return { rows: [{
            id: 'rel_new', source_app_id: 'app_src', release_number: 5,
            label: null, snapshot_id: 'snap_x', manifest: {}, notes: null,
            published_by: 'usr_1', published_at: new Date(),
          }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const controlDb = { connect: vi.fn(async () => client) } as any;
    const runtimePool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('repo_latest_snapshot')) return { rows: [{ repo_latest_snapshot: 'snap_x' }] };
        return { rows: [] };
      }),
    } as any;

    const { publishRelease } = await import('../services/template-releases.js');
    const rel = await publishRelease(controlDb, runtimePool, { query: async () => ({ rows: [] }) } as any, {
      sourceAppId: 'app_src', publishedBy: 'usr_1', label: null, notes: null,
    });

    expect(rel.release_number).toBe(5);
    expect(calls.some((c) => c.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(calls[0]).toContain('BEGIN');
    expect(calls.at(-1)).toContain('COMMIT');
    expect(runtimePool.query).toHaveBeenCalledWith(
      expect.stringContaining('latest_release_number'),
      [5, 'app_src'],
    );
  });
});
