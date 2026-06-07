import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export type AgentEvent = {
  seq: number;
  type: string;
  payload: unknown;
  created_at?: string;
};

export const TERMINAL_EVENTS = new Set(['run_end', 'run_failed', 'run_cancelled']);

export type StreamOpts = {
  db: Pool;
  runId: string;
  sinceSeq: number;
  onEvent: (e: AgentEvent) => void;
};

/** Returns a stop() function. Caller invokes stop() on disconnect. */
export async function streamEvents(opts: StreamOpts): Promise<() => Promise<void>> {
  const { db, runId, sinceSeq, onEvent } = opts;

  // 1. Create a dedicated subscriber (fresh connection per stream so pubsub
  //    is isolated and the shared sub client is not affected).
  const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

  // 2. Subscribe FIRST and buffer messages until replay is complete.
  const buffer: AgentEvent[] = [];
  let replayDone = false;
  let lastEmittedSeq = sinceSeq;
  let stopped = false;

  const handleEvent = (e: AgentEvent) => {
    if (stopped) return;
    if (e.seq <= lastEmittedSeq) return; // dedupe
    lastEmittedSeq = e.seq;
    onEvent(e);
    if (TERMINAL_EVENTS.has(e.type)) {
      stop().catch(() => {});
    }
  };

  sub.on('message', (_chan, msg) => {
    try {
      const e = JSON.parse(msg) as AgentEvent;
      if (!replayDone) {
        buffer.push(e);
      } else {
        handleEvent(e);
      }
    } catch {
      // ignore malformed
    }
  });

  await sub.subscribe(`agent_runs:${runId}`);

  // 3. Replay from DB.
  const { rows } = await db.query(
    `SELECT seq, type, payload, created_at
       FROM agent_run_events
      WHERE run_id = $1::uuid AND seq > $2
      ORDER BY seq ASC`,
    [runId, sinceSeq],
  );

  for (const r of rows) {
    // payload from asyncpg/jsonb may come as a string; parse if needed.
    const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    handleEvent({
      seq: Number(r.seq),
      type: r.type,
      payload,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    });
    if (stopped) break;
  }

  // 4. Drain buffer (messages that arrived during replay).
  replayDone = true;
  while (buffer.length > 0) {
    const e = buffer.shift()!;
    if (stopped) break;
    handleEvent(e);
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try { await sub.unsubscribe(); } catch {}
    try { sub.disconnect(); } catch {}
  }

  return stop;
}

/**
 * Pump a run's event stream into a Fastify reply as SSE.
 * Caller must have already verified auth before calling this.
 */
export async function streamRunEventsAsSse(
  runtimeDb: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  sinceSeq: number,
): Promise<void> {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const stop = await streamEvents({
    db: runtimeDb,
    runId,
    sinceSeq,
    onEvent: (e: AgentEvent) => {
      reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
      if (TERMINAL_EVENTS.has(e.type)) {
        reply.raw.end();
      }
    },
  });

  request.raw.on('close', () => {
    stop().catch(() => {});
  });
}

/**
 * Pump a run's event stream to a WebSocket socket.
 * Caller must have already verified auth before calling this.
 * Accepts either a raw WebSocket or the @fastify/websocket connection wrapper.
 */
export async function streamRunEventsToWebSocket(
  runtimeDb: Pool,
  socket: { readyState: number; OPEN: number; send(data: string): void; close(code?: number): void; on(event: string, cb: () => void): void },
  runId: string,
  sinceSeq: number,
): Promise<void> {
  const stop = await streamEvents({
    db: runtimeDb,
    runId,
    sinceSeq,
    onEvent: (e: AgentEvent) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(e));
      }
      if (TERMINAL_EVENTS.has(e.type)) {
        socket.close(1000);
      }
    },
  });

  socket.on('close', () => {
    stop().catch(() => {});
  });
}
