import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { FieldSchema } from '../services/hackathons/field-schema.js';
import { verifyCode } from '../services/hackathons/codes.js';
import { HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX } from '../services/hackathons/open-for-submissions.js';
import { setJudgeCookie, clearJudgeCookie, readJudgeCookie } from '../services/hackathons/judge-cookie.js';

function stripPrivate(schema: FieldSchema, data: Record<string, unknown>): Record<string, unknown> {
  const privateKeys = new Set(schema.fields.filter(f => f.display === 'private').map(f => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!privateKeys.has(k)) out[k] = v;
  return out;
}

/** Verifies the judge cookie for the given slug. Returns the hackathon row or null (reply already sent). */
async function requireJudge(
  request: FastifyRequest,
  reply: FastifyReply,
  app: FastifyInstance,
  slug: string,
): Promise<{ id: string; field_schema: FieldSchema; judge_code_set_at: string } | null> {
  const { rows } = await app.controlDb.query<{ id: string; field_schema: FieldSchema; judge_code_set_at: string }>(
    `SELECT id, field_schema, judge_code_set_at FROM hackathons WHERE slug = $1`,
    [slug]
  );
  if (rows.length === 0) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  const h = rows[0];
  const cookie = readJudgeCookie(request, h.id);
  if (!cookie) {
    reply.code(401).send({ error: 'judge_session_required' });
    return null;
  }
  // Compare as ISO strings — both come from the DB so they should serialize identically.
  // Normalise to avoid minor timezone/precision mismatches.
  const cookieTs = new Date(cookie.code_set_at).toISOString();
  const dbTs = new Date(h.judge_code_set_at).toISOString();
  if (cookieTs !== dbTs) {
    reply.code(401).send({ error: 'judge_session_expired' });
    return null;
  }
  return h;
}

export async function hackathonsPublicRoutes(app: FastifyInstance) {
  // ── Stays fully public ────────────────────────────────────────────────────
  app.get('/v1/public/hackathons/active', { config: { public: true } }, async (_request, reply) => {
    // MCP / dashboards — see HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX (date window, not is_active-only).
    const { rows } = await app.controlDb.query(
      `SELECT slug, name, starts_at, ends_at, submission_deadline FROM hackathons
       ${HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX}`
    );
    if (!rows.length) return reply.code(404).send({ error: 'no_active_hackathon' });
    return { hackathon: rows[0] };
  });

  app.get('/v1/public/hackathons', { config: { public: true } }, async () => {
    const { rows } = await app.controlDb.query(
      `SELECT slug, name, starts_at, ends_at, submission_deadline, is_active
         FROM hackathons
         ORDER BY is_active DESC, starts_at DESC`
    );
    return { hackathons: rows };
  });

  // ── Judge session endpoints ───────────────────────────────────────────────
  app.post('/v1/public/hackathons/:slug/judge-session', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code) return reply.code(400).send({ error: 'code_required' });

    const { rows } = await app.controlDb.query<{ id: string; judge_code_hash: string; judge_code_set_at: string }>(
      `SELECT id, judge_code_hash, judge_code_set_at FROM hackathons WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    const h = rows[0];

    const ok = await verifyCode(code, h.judge_code_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_judge_code' });

    setJudgeCookie(reply, { hackathon_id: h.id, code_set_at: new Date(h.judge_code_set_at).toISOString() });
    return reply.code(204).send();
  });

  app.delete('/v1/public/hackathons/:slug/judge-session', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { rows } = await app.controlDb.query<{ id: string }>(
      `SELECT id FROM hackathons WHERE slug = $1`, [slug]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    clearJudgeCookie(reply, rows[0].id);
    return reply.code(204).send();
  });

  // ── Gated reads ───────────────────────────────────────────────────────────
  app.get('/v1/public/hackathons/:slug', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // Fetch full row first so we can gate and return metadata in one round-trip.
    const { rows: hRows } = await app.controlDb.query<{
      id: string; slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
      field_schema: FieldSchema; judge_code_set_at: string;
    }>(
      `SELECT id, slug, name, starts_at, ends_at, submission_deadline, field_schema, judge_code_set_at
         FROM hackathons WHERE slug = $1`,
      [slug]
    );
    if (!hRows.length) return reply.code(404).send({ error: 'not_found' });
    const row = hRows[0];

    // Gate — reuse inline logic to avoid double-query inside requireJudge.
    const cookieVal = readJudgeCookie(request, row.id);
    if (!cookieVal) return reply.code(401).send({ error: 'judge_session_required' });
    const cookieTs = new Date(cookieVal.code_set_at).toISOString();
    const dbTs = new Date(row.judge_code_set_at).toISOString();
    if (cookieTs !== dbTs) return reply.code(401).send({ error: 'judge_session_expired' });

    const { rows: cnt } = await app.controlDb.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM hackathon_submissions WHERE hackathon_id = $1`, [row.id]
    );
    return {
      hackathon: {
        slug: row.slug, name: row.name,
        starts_at: row.starts_at, ends_at: row.ends_at,
        submission_deadline: row.submission_deadline,
      },
      field_schema: row.field_schema,
      submission_count: cnt[0].c,
    };
  });

  app.get('/v1/public/hackathons/:slug/submissions', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const h = await requireJudge(request, reply, app, slug);
    if (!h) return;

    const q = request.query as { limit?: string; cursor?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);

    const params: unknown[] = [h.id];
    let cursorClause = '';
    if (q.cursor) {
      params.push(q.cursor);
      cursorClause = `AND updated_at < $${params.length}`;
    }
    params.push(limit);
    const { rows } = await app.controlDb.query(
      `SELECT s.id, s.version, s.created_at, s.updated_at, s.data,
              sc.total_score, sc.criterion_demo_url, sc.criterion_features,
              sc.feature_breakdown, sc.scored_at,
              COALESCE(r.rating, 0) AS rating
         FROM hackathon_submissions s
         LEFT JOIN hackathon_scores sc ON sc.submission_id = s.id
         LEFT JOIN hackathon_submission_ratings r ON r.submission_id = s.id
        WHERE s.hackathon_id = $1 ${cursorClause}
        ORDER BY s.updated_at DESC LIMIT $${params.length}`, params
    );

    const submissions = rows.map(r => ({
      id: r.id, version: r.version,
      created_at: r.created_at, updated_at: r.updated_at,
      data: stripPrivate(h.field_schema, r.data),
      rating: Number(r.rating),
      score: r.scored_at ? {
        total_score: Number(r.total_score),
        criterion_demo_url: Number(r.criterion_demo_url),
        criterion_features: Number(r.criterion_features),
        feature_breakdown: r.feature_breakdown,
        scored_at: r.scored_at,
      } : null,
    }));
    const next_cursor = submissions.length === limit ? submissions[submissions.length - 1].updated_at : null;
    return { submissions, next_cursor };
  });

  /**
   * GET /v1/public/hackathons/:slug/leaderboard
   * Judge-gated leaderboard with dense ranking (ties share the same rank).
   */
  app.get('/v1/public/hackathons/:slug/leaderboard', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const h = await requireJudge(request, reply, app, slug);
    if (!h) return;

    const { rows } = await app.controlDb.query(
      `SELECT
          sc.total_score,
          sc.criterion_demo_url,
          sc.criterion_features,
          sc.feature_breakdown,
          sc.scored_at,
          COALESCE(r.rating, 0) AS rating,
          s.id AS submission_id,
          s.data,
          s.app_id,
          s.version,
          s.updated_at AS submitted_at,
          u.email AS user_email
       FROM hackathon_scores sc
       JOIN hackathon_submissions s ON s.id = sc.submission_id
       JOIN platform_users u ON u.id = sc.user_id
       LEFT JOIN hackathon_submission_ratings r ON r.submission_id = s.id
       WHERE sc.hackathon_id = $1
       ORDER BY COALESCE(r.rating, 0) DESC, sc.total_score DESC, sc.scored_at ASC`,
      [h.id]
    );

    let rank = 0;
    let prevKey: string | null = null;
    const leaderboard = rows.map(row => {
      const rating = Number(row.rating);
      const score = Number(row.total_score);
      const key = `${rating}|${score}`;
      if (key !== prevKey) {
        rank++;
        prevKey = key;
      }
      return {
        rank,
        ...row,
        rating,
        data: stripPrivate(h.field_schema, row.data),
      };
    });

    return { leaderboard };
  });

  /**
   * PUT /v1/public/hackathons/:slug/submissions/:id/rating
   * Shared rating: last write wins, no per-judge tracking. Body: { rating: 0..100 }.
   */
  app.put('/v1/public/hackathons/:slug/submissions/:id/rating', { config: { public: true } }, async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const h = await requireJudge(request, reply, app, slug);
    if (!h) return;

    const body = (request.body ?? {}) as { rating?: unknown };
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 100) {
      return reply.code(400).send({
        error: 'invalid_rating',
        hint: 'rating must be an integer between 0 and 100',
      });
    }

    const { rowCount } = await app.controlDb.query(
      `INSERT INTO hackathon_submission_ratings (submission_id, rating)
       SELECT s.id, $2::smallint FROM hackathon_submissions s
        WHERE s.id = $1 AND s.hackathon_id = $3
       ON CONFLICT (submission_id) DO UPDATE
         SET rating = EXCLUDED.rating, updated_at = now()`,
      [id, rating, h.id]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });

    // Belt-and-suspenders: fire notify directly so the SSE dispatcher always
    // receives the event, independent of the DB trigger running correctly.
    try {
      await app.controlDb.query(
        `SELECT pg_notify('hackathon_submission_changed', $1)`,
        [JSON.stringify({ hackathon_id: h.id, submission_id: id, op: 'UPDATE' })]
      );
    } catch (err) {
      app.log.warn({ err }, 'pg_notify after rating upsert failed; DB trigger will still fire');
    }

    return reply.code(204).send();
  });

  // SSE stream — one connection per browser. Backed by a process-level LISTEN.
  app.get('/v1/public/hackathons/:slug/submissions/stream', { config: { public: true } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const h = await requireJudge(request, reply, app, slug);
    if (!h) return;

    const { id: hackathonId, field_schema } = h;

    // reply.raw.writeHead bypasses Fastify's response pipeline, so CORS headers
    // set by the plugin on `reply` must be forwarded explicitly.
    const corsOrigin = reply.getHeader('access-control-allow-origin');
    const corsCredentials = reply.getHeader('access-control-allow-credentials');
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin as string } : {}),
      ...(corsCredentials ? { 'access-control-allow-credentials': corsCredentials as string } : {}),
    });
    reply.raw.write(': hello\n\n');

    // field_schema captured at connect time; clients must reconnect to pick up schema changes mid-stream.
    const handler = sseDispatcher.subscribe(hackathonId, async (submissionId, op) => {
      try {
        if (op === 'DELETE') {
          reply.raw.write(`event: submission.deleted\ndata: ${JSON.stringify({ id: submissionId })}\n\n`);
          return;
        }
        const { rows } = await app.controlDb.query(
          `SELECT s.id, s.version, s.created_at, s.updated_at, s.data,
                  sc.total_score, sc.criterion_demo_url, sc.criterion_features,
                  sc.feature_breakdown, sc.scored_at,
                  COALESCE(r.rating, 0) AS rating
             FROM hackathon_submissions s
             LEFT JOIN hackathon_scores sc ON sc.submission_id = s.id
             LEFT JOIN hackathon_submission_ratings r ON r.submission_id = s.id
            WHERE s.id = $1`,
          [submissionId]
        );
        if (!rows.length) return;
        const r = rows[0];
        const payload = {
          id: r.id, version: r.version,
          created_at: r.created_at, updated_at: r.updated_at,
          data: stripPrivate(field_schema, r.data),
          rating: Number(r.rating),
          score: r.scored_at ? {
            total_score: Number(r.total_score),
            criterion_demo_url: Number(r.criterion_demo_url),
            criterion_features: Number(r.criterion_features),
            feature_breakdown: r.feature_breakdown,
            scored_at: r.scored_at,
          } : null,
        };
        const event = op === 'INSERT' ? 'submission.created' : 'submission.updated';
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        request.log.error({ err }, 'SSE write failed');
      }
    });

    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 25_000);
    request.raw.on('close', () => { clearInterval(heartbeat); handler.unsubscribe(); });
  });
}

// Process-level LISTEN dispatcher. Single PG client; fan-out to per-connection callbacks.
type SubmissionListener = (submissionId: string, op: 'INSERT' | 'UPDATE' | 'DELETE') => void;

class SseDispatcher {
  private subs = new Map<string, Set<SubmissionListener>>();
  private started = false;
  private db: Pool | null = null;
  private client: import('pg').PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async start(db: Pool) {
    if (this.started) return;
    this.started = true;
    this.db = db;
    await this.connect();
  }

  private async connect() {
    try {
      const client = await this.db!.connect();
      this.client = client;
      client.on('notification', (msg) => {
        if (msg.channel !== 'hackathon_submission_changed' || !msg.payload) return;
        try {
          const { hackathon_id, submission_id, op } = JSON.parse(msg.payload);
          const subs = this.subs.get(hackathon_id);
          if (!subs) return;
          for (const fn of subs) fn(submission_id, op);
        } catch { /* ignore malformed payloads */ }
      });
      client.on('error', (err) => {
        console.error('SSE LISTEN client error — scheduling reconnect', err);
        this.scheduleReconnect();
      });
      client.on('end', () => {
        console.warn('SSE LISTEN client ended — scheduling reconnect');
        this.scheduleReconnect();
      });
      await client.query('LISTEN hackathon_submission_changed');
      console.log('SSE LISTEN client connected');
    } catch (err) {
      console.error('SSE LISTEN connect failed — scheduling retry', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return; // already scheduled
    if (this.client) {
      try { this.client.release(true); } catch { /* ignore */ }
      this.client = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1000);
  }

  /** Gracefully release the LISTEN client so the backing pool can be shut down. */
  stop() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.client) {
      try { this.client.release(true); } catch { /* ignore */ }
      this.client = null;
    }
    this.started = false;
    this.subs.clear();
  }

  subscribe(hackathonId: string, fn: SubmissionListener) {
    let set = this.subs.get(hackathonId);
    if (!set) { set = new Set(); this.subs.set(hackathonId, set); }
    set.add(fn);
    return {
      unsubscribe: () => {
        set!.delete(fn);
        if (set!.size === 0) this.subs.delete(hackathonId);
      },
    };
  }
}

export const sseDispatcher = new SseDispatcher();
