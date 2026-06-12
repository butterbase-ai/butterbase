import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { replayMeetingsWebhook } from '../clone-replay.js';
import { decrypt } from '../crypto.js';

const noopLogger = { info() {}, warn() {} };

function mockPool(rows: any[]) {
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

describe('replayMeetingsWebhook', () => {
  const TEST_KEY = 'a'.repeat(64); // 32 bytes hex
  const SRC = 'app_src_xxxxxxxxxxxxxx';
  const DEST = 'app_dst_yyyyyyyyyyyyyy';

  beforeEach(() => { process.env.AUTH_ENCRYPTION_KEY = TEST_KEY; });
  afterEach(() => { delete process.env.AUTH_ENCRYPTION_KEY; });

  it('no-ops when source has no webhook row', async () => {
    const { pool, queries } = mockPool([]);
    const r = await replayMeetingsWebhook(pool, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.warnings).toEqual([]);
    // Only the SELECT — no INSERT.
    expect(queries.length).toBe(1);
    expect(queries[0].sql).toContain('SELECT forward_url');
  });

  it('mints a fresh wsec_ secret and rewrites source app id in the forward URL', async () => {
    const sourceUrl = `https://runtime.example.com/v1/${SRC}/fn/notetaker-webhook`;
    const { pool, queries } = mockPool([{
      forward_url: sourceUrl,
      events: ['bot.done', 'transcript.done'],
    }]);

    const r = await replayMeetingsWebhook(pool, SRC, DEST, noopLogger);

    expect(r.minted).toBe(true);
    // INSERT was issued.
    const insert = queries.find((q) => q.sql.includes('INSERT INTO app_meetings_webhooks'));
    expect(insert).toBeDefined();
    const [appId, forwardUrl, encrypted, events] = insert!.params as [string, string, string, string[]];
    expect(appId).toBe(DEST);
    // Forward URL was rewritten — no leftover source id.
    expect(forwardUrl).toBe(`https://runtime.example.com/v1/${DEST}/fn/notetaker-webhook`);
    expect(forwardUrl.includes(SRC)).toBe(false);
    // Events array copied verbatim.
    expect(events).toEqual(['bot.done', 'transcript.done']);
    // Encrypted blob round-trips to a fresh wsec_ value.
    const plaintext = decrypt(encrypted, TEST_KEY);
    expect(plaintext.startsWith('wsec_')).toBe(true);
    // One-time warning surfaces the new secret to the caller.
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain(plaintext);
    expect(r.warnings[0]).toContain(DEST);
  });

  it('returns a warning (no throw) when AUTH_ENCRYPTION_KEY is unset', async () => {
    delete process.env.AUTH_ENCRYPTION_KEY;
    const { pool, queries } = mockPool([{
      forward_url: `https://x/v1/${SRC}/fn/wh`, events: [],
    }]);
    const r = await replayMeetingsWebhook(pool, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.warnings[0]).toMatch(/AUTH_ENCRYPTION_KEY/);
    // No INSERT attempted.
    expect(queries.some((q) => q.sql.includes('INSERT'))).toBe(false);
  });

  it('soft-fails (warning, no throw) when the INSERT errors', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT forward_url')) return { rows: [{ forward_url: `https://x/v1/${SRC}/fn/wh`, events: [] }] };
        throw new Error('unique constraint blew up');
      }),
    } as any;
    const r = await replayMeetingsWebhook(pool, SRC, DEST, noopLogger);
    expect(r.minted).toBe(false);
    expect(r.warnings[0]).toMatch(/replay failed/);
  });
});
