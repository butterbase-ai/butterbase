import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { lookupCachedProfile, writeCachedProfile } from './cache.js';
import type { ProfilePayload } from './types.js';

const APP_ID = 'app-test-123';
const URL = 'https://linkedin.com/in/jane-doe';
const SAMPLE_PAYLOAD: ProfilePayload = {
  publicIdentifier: 'jane-doe',
  firstName: 'Jane',
  lastName: 'Doe',
  fullName: 'Jane Doe',
  headline: 'CTO',
  occupation: null,
  summary: null,
  city: 'San Francisco',
  state: 'CA',
  country: 'US',
  experiences: [],
  education: [],
  raw: {},
};

function makePool(rows: unknown[] = []): Pool {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length } as unknown as QueryResult);
  return { query } as unknown as Pool;
}

// ─── lookupCachedProfile ────────────────────────────────────────────────────

describe('lookupCachedProfile', () => {
  it('returns null when DB result is empty (cache miss)', async () => {
    const pool = makePool([]);
    const result = await lookupCachedProfile(pool, APP_ID, URL);
    expect(result).toBeNull();
  });

  it('returns { status: "ok", payload } when DB returns an ok row', async () => {
    const pool = makePool([{ status: 'ok', payload_jsonb: SAMPLE_PAYLOAD }]);
    const result = await lookupCachedProfile(pool, APP_ID, URL);
    expect(result).toEqual({ status: 'ok', payload: SAMPLE_PAYLOAD });
  });

  it('returns { status: "not_found", payload: null } for negative-cache row', async () => {
    const pool = makePool([{ status: 'not_found', payload_jsonb: null }]);
    const result = await lookupCachedProfile(pool, APP_ID, URL);
    expect(result).toEqual({ status: 'not_found', payload: null });
  });

  it('returns null when DB returns a "failed" row (treat as miss)', async () => {
    const pool = makePool([{ status: 'failed', payload_jsonb: null }]);
    const result = await lookupCachedProfile(pool, APP_ID, URL);
    expect(result).toBeNull();
  });

  it('queries with the correct app_id and normalizedUrl params', async () => {
    const pool = makePool([]);
    await lookupCachedProfile(pool, APP_ID, URL);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('people_profile_cache'),
      [APP_ID, URL],
    );
  });
});

// ─── writeCachedProfile ─────────────────────────────────────────────────────

describe('writeCachedProfile', () => {
  it('upserts with interval "30 days" for status=ok', async () => {
    const pool = makePool([]);
    await writeCachedProfile(pool, APP_ID, URL, 'ok', SAMPLE_PAYLOAD);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("interval '30 days'"),
      [APP_ID, URL, 'ok', SAMPLE_PAYLOAD],
    );
  });

  it('upserts with interval "7 days" for status=not_found', async () => {
    const pool = makePool([]);
    await writeCachedProfile(pool, APP_ID, URL, 'not_found', null);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("interval '7 days'"),
      [APP_ID, URL, 'not_found', null],
    );
  });

  it('upserts with interval "1 hours" for status=failed', async () => {
    const pool = makePool([]);
    await writeCachedProfile(pool, APP_ID, URL, 'failed', null);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("interval '1 hours'"),
      [APP_ID, URL, 'failed', null],
    );
  });

  it('uses ON CONFLICT upsert semantics — second call overwrites', async () => {
    const pool = makePool([]);
    await writeCachedProfile(pool, APP_ID, URL, 'ok', SAMPLE_PAYLOAD);
    await writeCachedProfile(pool, APP_ID, URL, 'not_found', null);
    expect(pool.query).toHaveBeenCalledTimes(2);
    // Both calls should use the UPSERT ON CONFLICT clause
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    for (const [sql] of calls) {
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('DO UPDATE');
    }
  });
});
