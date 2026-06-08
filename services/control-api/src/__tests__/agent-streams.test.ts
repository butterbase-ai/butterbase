/**
 * Unit tests for agent-event-stream.ts
 *
 * Strategy: mock db.query to return fixture rows, use a real Redis pub client
 * to exercise live pubsub, and capture events via the onEvent callback.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { streamEvents, TERMINAL_EVENTS } from '../services/agent-event-stream.js';

// A tiny Pool stand-in that lets each test configure rows to return.
function makeDb(rows: object[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

afterAll(async () => {
  await pub.quit();
});

// Small helper: wait up to `ms` for a predicate to become true.
async function waitFor(pred: () => boolean, ms = 1000, interval = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('TERMINAL_EVENTS', () => {
  it('contains run_end, run_failed, run_cancelled', () => {
    expect(TERMINAL_EVENTS.has('run_end')).toBe(true);
    expect(TERMINAL_EVENTS.has('run_failed')).toBe(true);
    expect(TERMINAL_EVENTS.has('run_cancelled')).toBe(true);
    expect(TERMINAL_EVENTS.has('node_start')).toBe(false);
  });
});

describe('streamEvents — DB replay', () => {
  it('replays rows from DB in order', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const db = makeDb([
      { seq: 1, type: 'node_start', payload: { node: 'a' }, created_at: null },
      { seq: 2, type: 'node_start', payload: { node: 'b' }, created_at: null },
      { seq: 3, type: 'node_start', payload: { node: 'c' }, created_at: null },
    ]);

    const received: { seq: number; type: string }[] = [];
    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push({ seq: e.seq, type: e.type }),
    });
    await stop();

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('filters rows with seq <= sinceSeq', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000002';
    const db = makeDb([
      { seq: 2, type: 'node_start', payload: {}, created_at: null },
      { seq: 3, type: 'node_start', payload: {}, created_at: null },
    ]);

    const received: number[] = [];
    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 1, // DB query already filters, but dedup layer also guards
      onEvent: (e) => received.push(e.seq),
    });
    await stop();

    expect(received).toEqual([2, 3]);
  });

  it('stops early when a terminal event arrives from DB', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000003';
    const db = makeDb([
      { seq: 1, type: 'node_start', payload: {}, created_at: null },
      { seq: 2, type: 'run_end', payload: { output: 'done' }, created_at: null },
      { seq: 3, type: 'node_start', payload: {}, created_at: null }, // should NOT arrive
    ]);

    const received: number[] = [];
    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push(e.seq),
    });
    await stop();

    // seq=3 must not arrive because run_end terminates the stream
    expect(received).toContain(1);
    expect(received).toContain(2);
    expect(received).not.toContain(3);
  });

  it('deduplicates events that arrive via both DB replay and Redis pub', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000004';
    const db = makeDb([
      { seq: 1, type: 'node_start', payload: {}, created_at: null },
      { seq: 2, type: 'node_start', payload: {}, created_at: null },
    ]);

    const received: number[] = [];
    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push(e.seq),
    });

    // Publish seq=2 again (duplicate) and seq=3 (new) after replay
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 2, type: 'node_start', payload: {}, created_at: null }),
    );
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 3, type: 'node_start', payload: {}, created_at: null }),
    );

    await waitFor(() => received.includes(3));
    await stop();

    const counts = received.reduce<Record<number, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    // seq=2 must appear exactly once despite being sent via both paths
    expect(counts[2]).toBe(1);
    expect(counts[3]).toBe(1);
  });
});

describe('streamEvents — Redis live events', () => {
  it('delivers events published after replay completes', async () => {
    const runId = 'bbbbbbbb-0000-0000-0000-000000000001';
    const db = makeDb([]); // no DB rows

    const received: { seq: number; type: string }[] = [];
    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push({ seq: e.seq, type: e.type }),
    });

    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 1, type: 'node_start', payload: { x: 1 }, created_at: null }),
    );
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 2, type: 'node_start', payload: { x: 2 }, created_at: null }),
    );

    await waitFor(() => received.length >= 2);
    await stop();

    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('auto-stops on terminal event via Redis', async () => {
    const runId = 'bbbbbbbb-0000-0000-0000-000000000002';
    const db = makeDb([]);

    const received: { seq: number; type: string }[] = [];
    let stopped = false;

    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push({ seq: e.seq, type: e.type }),
    });

    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 1, type: 'node_start', payload: {}, created_at: null }),
    );
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 2, type: 'run_end', payload: { output: 'ok' }, created_at: null }),
    );
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 3, type: 'node_start', payload: {}, created_at: null }), // after terminal
    );

    await waitFor(() => received.some((e) => e.type === 'run_end'));

    // Give a brief moment for seq=3 to potentially slip through (it should not)
    await new Promise((r) => setTimeout(r, 80));

    stopped = true; // mark so cleanup below knows we already waited
    await stop();

    expect(stopped).toBe(true);
    expect(received.some((e) => e.type === 'run_end')).toBe(true);
    expect(received.every((e) => e.seq <= 2)).toBe(true);
  });

  it('handles events published during DB replay via buffer', async () => {
    const runId = 'bbbbbbbb-0000-0000-0000-000000000003';

    // To test the buffer path we need:
    //   1. The stream subscriber to be subscribed (so it can receive messages)
    //   2. The DB query to still be pending (so replayDone=false and messages buffer)
    //   3. A Redis message to arrive while the DB query pends
    //   4. The DB query to then resolve, draining the buffer in order
    //
    // We use a db.query mock that first notifies us it was called (subscribe is done),
    // then blocks until we explicitly resolve it.

    let resolveDb!: (v: { rows: object[] }) => void;
    let dbQueryCalled = false;
    const dbLatch = new Promise<{ rows: object[] }>((r) => { resolveDb = r; });

    const db = {
      query: vi.fn().mockImplementation(() => {
        dbQueryCalled = true;
        return dbLatch;
      }),
    };

    const received: number[] = [];
    const streamPromise = streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push(e.seq),
    });

    // Wait until db.query has been called — at that point sub.subscribe() has
    // already resolved and the stream's message handler is active.
    await waitFor(() => dbQueryCalled, 2000);

    // Now publish seq=10. The stream is subscribed but DB is still pending,
    // so seq=10 will land in the buffer.
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 10, type: 'node_start', payload: {}, created_at: null }),
    );

    // Small delay so the Redis message has time to reach the subscriber
    await new Promise((r) => setTimeout(r, 80));

    // Resolve the DB with seq=5 — buffer should then drain with seq=10 after
    resolveDb({ rows: [{ seq: 5, type: 'node_start', payload: {}, created_at: null }] });

    const stop = await streamPromise;
    await stop();

    expect(received).toContain(5);
    expect(received).toContain(10);
    // Order: DB row (seq=5) must appear before buffered (seq=10)
    expect(received.indexOf(5)).toBeLessThan(received.indexOf(10));
  });

  it('ignores malformed Redis messages', async () => {
    const runId = 'bbbbbbbb-0000-0000-0000-000000000004';
    const db = makeDb([]);
    const received: number[] = [];

    const stop = await streamEvents({
      db: db as any,
      runId,
      sinceSeq: 0,
      onEvent: (e) => received.push(e.seq),
    });

    await pub.publish(`agent_runs:${runId}`, 'not-json!');
    await pub.publish(
      `agent_runs:${runId}`,
      JSON.stringify({ seq: 99, type: 'node_start', payload: {}, created_at: null }),
    );

    await waitFor(() => received.includes(99));
    await stop();

    expect(received).toContain(99);
    // Malformed message must not crash the stream
  });
});
