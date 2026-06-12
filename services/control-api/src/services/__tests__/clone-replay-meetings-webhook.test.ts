import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { replayMeetingsWebhook, parseReceiverFunctionName } from '../clone-replay.js';
import { decrypt, encrypt } from '../crypto.js';

const noopLogger = { info() {}, warn() {} };

function mockControlPool(rows: any[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT forward_url')) return { rows };
      return { rows: [] };
    }),
  } as any;
  return { pool, queries };
}

function mockDestRuntimePool(fnRow: { id: string; encrypted_env_vars: string | null } | null) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let lastUpdate: { id: string; encrypted_env_vars: string } | null = null;
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT id, encrypted_env_vars FROM app_functions')) {
        return { rows: fnRow ? [fnRow] : [] };
      }
      if (sql.startsWith('UPDATE app_functions')) {
        lastUpdate = { id: params[1] as string, encrypted_env_vars: params[0] as string };
        return { rows: [] };
      }
      return { rows: [] };
    }),
  } as any;
  return { pool, queries, getLastUpdate: () => lastUpdate };
}

describe('parseReceiverFunctionName', () => {
  it('extracts the function name from a /v1/{app}/fn/{name} URL', () => {
    expect(parseReceiverFunctionName('https://api.example.com/v1/app_xyz/fn/notetaker-webhook', 'app_xyz')).toBe('notetaker-webhook');
  });
  it('returns null for URLs that do not match the /fn/ convention', () => {
    expect(parseReceiverFunctionName('https://hooks.zapier.com/x/y/z', 'app_xyz')).toBeNull();
  });
  it('returns null when the path is for a different app id', () => {
    expect(parseReceiverFunctionName('https://api.example.com/v1/app_other/fn/notetaker', 'app_xyz')).toBeNull();
  });
  it('handles trailing path segments', () => {
    expect(parseReceiverFunctionName('https://api.example.com/v1/app_xyz/fn/wh/extra', 'app_xyz')).toBe('wh');
  });
});

describe('replayMeetingsWebhook', () => {
  const TEST_KEY = 'a'.repeat(64); // 32 bytes hex
  const SRC = 'app_src_xxxxxxxxxxxxxx';
  const DEST = 'app_dst_yyyyyyyyyyyyyy';

  beforeEach(() => { process.env.AUTH_ENCRYPTION_KEY = TEST_KEY; });
  afterEach(() => { delete process.env.AUTH_ENCRYPTION_KEY; });

  it('no-ops when source has no webhook row', async () => {
    const { pool: control, queries } = mockControlPool([]);
    const { pool: runtime } = mockDestRuntimePool(null);
    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.filledFnEnvVar).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(queries.length).toBe(1);
  });

  it('mints + wires the wsec_ into the receiver function and produces a wired warning', async () => {
    const sourceUrl = `https://runtime.example.com/v1/${SRC}/fn/notetaker-webhook`;
    const { pool: control, queries: controlQ } = mockControlPool([{
      forward_url: sourceUrl,
      events: ['bot.done', 'transcript.done'],
    }]);
    // Pre-existing function has one unrelated env var; we should preserve it
    // and add NOTETAKER_WEBHOOK_SECRET alongside.
    const existingEnv = encrypt(JSON.stringify({ BUTTERBASE_API_KEY: 'bb_sk_existing' }), TEST_KEY);
    const { pool: runtime, getLastUpdate } = mockDestRuntimePool({
      id: 'fn_xyz', encrypted_env_vars: existingEnv,
    });

    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);

    expect(r.minted).toBe(true);
    expect(r.filledFnEnvVar).toEqual({ fnName: 'notetaker-webhook', key: 'NOTETAKER_WEBHOOK_SECRET' });

    // Insert into app_meetings_webhooks went to control DB.
    const insert = controlQ.find((q) => q.sql.includes('INSERT INTO app_meetings_webhooks'));
    expect(insert).toBeDefined();
    const [, forwardUrl] = insert!.params as [string, string];
    expect(forwardUrl).toBe(`https://runtime.example.com/v1/${DEST}/fn/notetaker-webhook`);

    // Function env vars were merged + re-encrypted.
    const upd = getLastUpdate();
    expect(upd).not.toBeNull();
    const decrypted = JSON.parse(decrypt(upd!.encrypted_env_vars, TEST_KEY)) as Record<string, string>;
    expect(decrypted.BUTTERBASE_API_KEY).toBe('bb_sk_existing');
    expect(decrypted.NOTETAKER_WEBHOOK_SECRET.startsWith('wsec_')).toBe(true);

    // Wired warning (no secret embedded) — secret was applied automatically.
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('wired into notetaker-webhook');
    expect(r.warnings[0]).not.toContain(decrypted.NOTETAKER_WEBHOOK_SECRET);
  });

  it('falls back to the one-time-secret warning when receiver function is missing', async () => {
    const sourceUrl = `https://x.example.com/v1/${SRC}/fn/notetaker-webhook`;
    const { pool: control } = mockControlPool([{ forward_url: sourceUrl, events: [] }]);
    const { pool: runtime } = mockDestRuntimePool(null);

    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);

    expect(r.minted).toBe(true);
    expect(r.filledFnEnvVar).toBeNull();
    expect(r.warnings[0]).toMatch(/NEW signing secret \(shown once/);
    expect(r.warnings[0]).toMatch(/wsec_/);
  });

  it('falls back to the one-time-secret warning when forward URL is external (no /fn/ pattern)', async () => {
    const { pool: control } = mockControlPool([{
      forward_url: 'https://hooks.zapier.com/abc/def', events: [],
    }]);
    const { pool: runtime, getLastUpdate } = mockDestRuntimePool({
      id: 'fn_xyz', encrypted_env_vars: null,
    });

    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);

    expect(r.minted).toBe(true);
    expect(r.filledFnEnvVar).toBeNull();
    expect(getLastUpdate()).toBeNull(); // no function lookup attempted
    expect(r.warnings[0]).toMatch(/wsec_/);
  });

  it('returns a warning (no throw) when AUTH_ENCRYPTION_KEY is unset', async () => {
    delete process.env.AUTH_ENCRYPTION_KEY;
    const { pool: control, queries } = mockControlPool([{
      forward_url: `https://x/v1/${SRC}/fn/wh`, events: [],
    }]);
    const { pool: runtime } = mockDestRuntimePool(null);
    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.warnings[0]).toMatch(/AUTH_ENCRYPTION_KEY/);
    expect(queries.some((q) => q.sql.includes('INSERT'))).toBe(false);
  });

  it('soft-fails (warning, no throw) when the INSERT errors', async () => {
    const control = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT forward_url')) return { rows: [{ forward_url: `https://x/v1/${SRC}/fn/wh`, events: [] }] };
        throw new Error('unique constraint blew up');
      }),
    } as any;
    const { pool: runtime } = mockDestRuntimePool(null);
    const r = await replayMeetingsWebhook(control, runtime, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.warnings[0]).toMatch(/replay failed/);
  });
});
