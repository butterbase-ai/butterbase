/**
 * Paging the operator trace viewer.
 *
 * The thing under test is the boundary arithmetic, so these run against a real
 * Postgres rather than a stubbed pool: the page is chosen by a row-value
 * comparison `(created_at, id) < ($1, $2)` against the same tuple the ORDER BY
 * uses, and a fake that pattern-matches SQL would agree with whatever the code
 * did, including the off-by-one it exists to catch.
 *
 * The regression that motivated all of this has its own test: turn 51 used to
 * be unreachable at any limit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { listOperatorTraces } from '../operator-traces.js';

const CONN =
  process.env.DATABASE_URL || 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

/** Turns to seed. Deliberately past the old MAX_TURNS = 50 ceiling. */
const TURNS = 60;
const STEPS_PER_TURN = 3;

let pool: pg.Pool;
let conversationId: string;
let orgId: string;

/** Wake `n` (1-based) — the content is the assertable identity of a turn. */
const wakeText = (n: number) => `wake ${n}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONN, max: 5 });

  const stamp = Date.now();
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, owner_id, personal)
     VALUES ($1, gen_random_uuid(), true) RETURNING id`,
    [`traces-test-${stamp}`],
  );
  orgId = org.rows[0].id;

  const conv = await pool.query<{ id: string }>(
    `INSERT INTO dashboard_agent_conversations (organization_id, user_id, title, model)
     VALUES ($1, gen_random_uuid(), 'traces test', 'test-model') RETURNING id`,
    [orgId],
  );
  conversationId = conv.rows[0].id;

  // Timestamps are explicit and one minute apart. Two rows sharing a
  // millisecond is exactly what the id half of the cursor is for, so the last
  // turn's rows are deliberately given an IDENTICAL created_at.
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  for (let t = 1; t <= TURNS; t++) {
    const at = new Date(base + t * 60_000);
    await pool.query(
      `INSERT INTO dashboard_agent_messages (conversation_id, role, content, created_at)
       VALUES ($1, 'user', $2, $3)`,
      [conversationId, wakeText(t), at],
    );
    for (let s = 0; s < STEPS_PER_TURN; s++) {
      await pool.query(
        `INSERT INTO dashboard_agent_messages
           (conversation_id, role, content, tool_name, tool_args, tool_result, created_at)
         VALUES ($1, 'tool', '', $2, '{}'::jsonb, '{"ok":true}'::jsonb, $3)`,
        [conversationId, `tool_${s}`, new Date(at.getTime() + (s + 1) * 1000)],
      );
    }
  }
});

afterAll(async () => {
  if (conversationId) {
    await pool.query(`DELETE FROM dashboard_agent_messages WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM dashboard_agent_conversations WHERE id = $1`, [conversationId]);
  }
  if (orgId) await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await pool.end();
});

describe('listOperatorTraces paging', () => {
  it('limit means TURNS, not messages', async () => {
    const page = await listOperatorTraces(pool, conversationId, { limit: 3 });
    expect(page.traces).toHaveLength(3);
    // Newest first: turn 60, 59, 58.
    expect(page.traces.map((t) => t.wake)).toEqual([wakeText(60), wakeText(59), wakeText(58)]);
  });

  it('every returned turn has its head — no half-turns', async () => {
    const page = await listOperatorTraces(pool, conversationId, { limit: 10 });
    for (const t of page.traces) {
      expect(t.wake).not.toBe('');
      expect(t.steps).toHaveLength(STEPS_PER_TURN);
    }
  });

  it("a turn's steps stop at the next wake", async () => {
    // The upper bound is the whole reason for the second query. Without it the
    // transcript read runs to the end of the conversation and every later
    // turn's steps pile onto the last turn of the page.
    const page = await listOperatorTraces(pool, conversationId, { limit: 1 });
    expect(page.traces[0].wake).toBe(wakeText(60));
    expect(page.traces[0].steps).toHaveLength(STEPS_PER_TURN);

    const middle = await listOperatorTraces(pool, conversationId, { limit: 1, cursor: page.nextCursor });
    expect(middle.traces[0].wake).toBe(wakeText(59));
    expect(middle.traces[0].steps).toHaveLength(STEPS_PER_TURN);
  });

  it('the cursor reaches turn 51 and beyond — the old 50 ceiling is gone', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listOperatorTraces>> = await listOperatorTraces(
        pool,
        conversationId,
        { limit: 10, cursor },
      );
      seen.push(...page.traces.map((t) => t.wake));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(20); // a cursor that stops advancing must fail, not hang
    } while (cursor);

    expect(seen).toHaveLength(TURNS);
    // No repeats and no gaps: the walk is exactly the conversation, once.
    expect(new Set(seen).size).toBe(TURNS);
    const expected = Array.from({ length: TURNS }, (_, i) => wakeText(TURNS - i));
    expect(seen).toEqual(expected);
    expect(seen).toContain(wakeText(51));
    expect(seen).toContain(wakeText(1));
  });

  it('nextCursor is null only on the last page', async () => {
    const first = await listOperatorTraces(pool, conversationId, { limit: TURNS - 1 });
    expect(first.nextCursor).not.toBeNull();

    const whole = await listOperatorTraces(pool, conversationId, { limit: TURNS });
    expect(whole.traces).toHaveLength(TURNS);
    expect(whole.nextCursor).toBeNull();
  });

  it('order=oldest walks the other way', async () => {
    const page = await listOperatorTraces(pool, conversationId, { limit: 3, order: 'oldest' });
    expect(page.traces.map((t) => t.wake)).toEqual([wakeText(1), wakeText(2), wakeText(3)]);

    const next = await listOperatorTraces(pool, conversationId, {
      limit: 3,
      order: 'oldest',
      cursor: page.nextCursor,
    });
    expect(next.traces.map((t) => t.wake)).toEqual([wakeText(4), wakeText(5), wakeText(6)]);
  });

  it('since/until filter on when the turn STARTED', async () => {
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    // Turns 10..12 inclusive.
    const since = new Date(base + 10 * 60_000);
    const until = new Date(base + 12 * 60_000);

    const page = await listOperatorTraces(pool, conversationId, { limit: 50, since, until });
    expect(page.traces.map((t) => t.wake)).toEqual([wakeText(12), wakeText(11), wakeText(10)]);
    expect(page.nextCursor).toBeNull();
  });

  it('an unreadable cursor shows the first page rather than failing', async () => {
    const page = await listOperatorTraces(pool, conversationId, { limit: 2, cursor: 'not-a-cursor' });
    expect(page.traces.map((t) => t.wake)).toEqual([wakeText(60), wakeText(59)]);
  });

  it('a page size over the ceiling is clamped, not honoured', async () => {
    const page = await listOperatorTraces(pool, conversationId, { limit: 5000 });
    expect(page.traces.length).toBeLessThanOrEqual(100);
  });

  it('an empty conversation pages to nothing', async () => {
    const empty = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_agent_conversations (organization_id, user_id, title, model)
       VALUES ($1, gen_random_uuid(), 'empty', 'test-model') RETURNING id`,
      [orgId],
    );
    const page = await listOperatorTraces(pool, empty.rows[0].id, { limit: 10 });
    expect(page.traces).toEqual([]);
    expect(page.nextCursor).toBeNull();
    await pool.query(`DELETE FROM dashboard_agent_conversations WHERE id = $1`, [empty.rows[0].id]);
  });
});
