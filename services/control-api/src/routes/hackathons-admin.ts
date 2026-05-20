import type { FastifyInstance } from 'fastify';
import { normalizeFieldSchemaInput, validateMetaSchema, type FieldSchema } from '../services/hackathons/field-schema.js';
import { requireAdmin } from './admin-auth.js';
import { generateCode, hashCode, validateCustomCode } from '../services/hackathons/codes.js';
import { scoreSubmission } from '../services/hackathons/scoring.js';

/** Strip hash columns from a hackathon row before returning to callers.
 *  Hashes are internal; plaintext is revealed once at create/rotate. */
function stripHashes<T extends Record<string, unknown>>(row: T): Omit<T, 'submission_code_hash' | 'judge_code_hash'> {
  const { submission_code_hash, judge_code_hash, ...rest } = row;
  void submission_code_hash; void judge_code_hash;
  return rest;
}

export async function hackathonsAdminRoutes(app: FastifyInstance) {

  app.post('/admin/hackathons', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const body = request.body as {
      slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
      field_schema: unknown; is_active?: boolean;
      submission_code?: string; judge_code?: string;
    };
    const fieldSchema = normalizeFieldSchemaInput(body.field_schema);
    const meta = validateMetaSchema(fieldSchema);
    if (!meta.ok) return reply.code(400).send({ error: 'invalid_field_schema', errors: meta.errors });

    // Validate any custom codes supplied by the caller.
    for (const [field, value] of [['submission_code', body.submission_code], ['judge_code', body.judge_code]] as [string, string | undefined][]) {
      if (value !== undefined) {
        const r = validateCustomCode(value);
        if (!r.ok) return reply.code(400).send({ error: 'invalid_code_format', field, reason: r.reason });
      }
    }

    // Auto-generate codes when not supplied. Hash both.
    // Plaintext is returned in this response and NOWHERE ELSE.
    const submissionCode = body.submission_code ?? generateCode();
    const judgeCode      = body.judge_code      ?? generateCode();
    const submissionHash = await hashCode(submissionCode);
    const judgeHash      = await hashCode(judgeCode);

    const { rows } = await app.controlDb.query(
      `INSERT INTO hackathons (slug, name, starts_at, ends_at, submission_deadline, field_schema, is_active,
                               submission_code_hash, judge_code_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [body.slug, body.name, body.starts_at, body.ends_at, body.submission_deadline,
       JSON.stringify(fieldSchema), body.is_active ?? false, submissionHash, judgeHash]
    );

    // Return stripped row with one-time plaintext reveal.
    return reply.code(201).send({
      hackathon: { ...stripHashes(rows[0]), submission_code: submissionCode, judge_code: judgeCode },
    });
  });

  app.get('/admin/hackathons', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const { rows } = await app.controlDb.query(`SELECT * FROM hackathons ORDER BY starts_at DESC`);
    return { hackathons: rows.map(stripHashes) };
  });

  app.get('/admin/hackathons/:slug', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const { slug } = request.params as { slug: string };
    const { rows } = await app.controlDb.query(`SELECT * FROM hackathons WHERE slug = $1`, [slug]);
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    return { hackathon: stripHashes(rows[0]) };
  });

  /**
   * POST /admin/hackathons/:slug/rotate-code
   * body: { kind: "submission" | "judge", value?: string }
   * Returns: { kind, code: "<plaintext>", set_at: "<ISO timestamp>" }
   * Plaintext is revealed ONCE in this response and NOWHERE ELSE.
   */
  app.post('/admin/hackathons/:slug/rotate-code', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const { slug } = request.params as { slug: string };
    const body = request.body as { kind: 'submission' | 'judge'; value?: string };

    if (body.kind !== 'submission' && body.kind !== 'judge') {
      return reply.code(400).send({ error: 'invalid_kind' });
    }
    if (body.value !== undefined) {
      const r = validateCustomCode(body.value);
      if (!r.ok) return reply.code(400).send({ error: 'invalid_code_format', reason: r.reason });
    }

    const plaintext = body.value ?? generateCode();
    const hash = await hashCode(plaintext);

    const col    = body.kind === 'submission' ? 'submission_code_hash' : 'judge_code_hash';
    const setCol = body.kind === 'submission' ? 'submission_code_set_at' : 'judge_code_set_at';

    const { rowCount, rows } = await app.controlDb.query(
      `UPDATE hackathons SET ${col} = $1, ${setCol} = now()
       WHERE slug = $2
       RETURNING ${setCol} AS set_at`,
      [hash, slug]
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });

    return { kind: body.kind, code: plaintext, set_at: rows[0].set_at };
  });

  app.patch('/admin/hackathons/:slug', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const { slug } = request.params as { slug: string };
    const body = request.body as Partial<{
      name: string; starts_at: string; ends_at: string; submission_deadline: string;
      field_schema: unknown; is_active: boolean;
    }>;
    let fieldSchemaForPatch: unknown | undefined;
    if (body.field_schema !== undefined) {
      fieldSchemaForPatch = normalizeFieldSchemaInput(body.field_schema);
      const meta = validateMetaSchema(fieldSchemaForPatch);
      if (!meta.ok) return reply.code(400).send({ error: 'invalid_field_schema', errors: meta.errors });
    }
    const sets: string[] = []; const vals: unknown[] = []; let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      sets.push(`${k} = $${i++}`);
      vals.push(k === 'field_schema' ? JSON.stringify(fieldSchemaForPatch) : v);
    }
    if (!sets.length) return reply.code(400).send({ error: 'no_fields_to_update' });
    sets.push(`updated_at = now()`);
    vals.push(slug);
    const { rows } = await app.controlDb.query(
      `UPDATE hackathons SET ${sets.join(', ')} WHERE slug = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    return { hackathon: stripHashes(rows[0]) };
  });

  /**
   * DELETE /admin/hackathons/:slug
   * Hard-delete a hackathon and all its participants, submissions, and scores
   * (FK constraints cascade). Intended for cleaning up test data.
   */
  app.delete('/admin/hackathons/:slug', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return;
    const { slug } = request.params as { slug: string };
    const { rowCount } = await app.controlDb.query(
      `DELETE FROM hackathons WHERE slug = $1`, [slug]
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/admin/hackathons/:slug/activate', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return; // requireAdmin already sent the response
    const { slug } = request.params as { slug: string };
    const client = await app.controlDb.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE hackathons SET is_active = false, updated_at = now() WHERE is_active`);
      const { rows } = await client.query(`UPDATE hackathons SET is_active = true, updated_at = now() WHERE slug = $1 RETURNING *`, [slug]);
      if (!rows.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'not_found' }); }
      await client.query('COMMIT');
      return { hackathon: stripHashes(rows[0]) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.patch('/admin/hackathons/:slug/participants/:id', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return;
    const { id } = request.params as { id: string };
    const body = request.body as { status?: 'active' | 'revoked' };
    if (body.status !== 'active' && body.status !== 'revoked') {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const { rowCount, rows } = await app.controlDb.query(
      `UPDATE hackathon_participants SET status = $1
       WHERE id = $2
       RETURNING id, hackathon_id, user_id, status, source, created_at`,
      [body.status, id]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return { participant: rows[0] };
  });

  app.get('/admin/hackathons/:slug/participants', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return;
    const { slug } = request.params as { slug: string };
    const { rows } = await app.controlDb.query(
      `SELECT p.id, p.user_id, p.status, p.source, p.created_at,
              u.email AS user_email,
              s.id AS submission_id, s.version AS submission_version, s.updated_at AS submission_updated_at
         FROM hackathon_participants p
         JOIN hackathons h ON h.id = p.hackathon_id
         JOIN platform_users u ON u.id = p.user_id
         LEFT JOIN hackathon_submissions s
                ON s.hackathon_id = p.hackathon_id AND s.participant_id = p.id
        WHERE h.slug = $1
     ORDER BY p.created_at DESC`,
      [slug]
    );
    return { participants: rows };
  });

  /**
   * POST /admin/hackathons/:slug/rescore
   * Re-score all submissions for a hackathon. Useful after deadline or if scoring logic changed.
   */
  app.post('/admin/hackathons/:slug/rescore', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return;
    const { slug } = request.params as { slug: string };

    const { rows: hRows } = await app.controlDb.query<{ id: string; field_schema: unknown }>(
      `SELECT id, field_schema FROM hackathons WHERE slug = $1`, [slug]
    );
    if (!hRows.length) return reply.code(404).send({ error: 'not_found' });
    const hackathonId = hRows[0].id;
    const rawFs = hRows[0].field_schema;
    const fieldSchema: FieldSchema | null =
      rawFs != null &&
      typeof rawFs === 'object' &&
      'fields' in rawFs &&
      Array.isArray((rawFs as FieldSchema).fields)
        ? (rawFs as FieldSchema)
        : null;

    const { rows: submissions } = await app.controlDb.query<{
      id: string; participant_id: string; user_id: string; data: Record<string, unknown>; app_id: string | null;
    }>(
      `SELECT s.id, s.participant_id, s.user_id, s.data, s.app_id
         FROM hackathon_submissions s
        WHERE s.hackathon_id = $1`,
      [hackathonId]
    );

    const results = await Promise.allSettled(
      submissions.map(s =>
        scoreSubmission(app.controlDb, {
          id: s.id,
          hackathon_id: hackathonId,
          participant_id: s.participant_id,
          user_id: s.user_id,
          data: s.data,
          app_id: s.app_id,
          field_schema: fieldSchema,
        }, request.log)
      )
    );

    const errors = results.filter(r => r.status === 'rejected').length;
    return { scored: submissions.length - errors, errors, total: submissions.length };
  });

  /**
   * GET /admin/hackathons/:slug/leaderboard
   * Returns ranked submissions with scores. Ties get the same rank (dense ranking).
   */
  app.get('/admin/hackathons/:slug/leaderboard', async (request, reply) => {
    const adminUserId = await requireAdmin(app, request, reply);
    if (!adminUserId) return;
    const { slug } = request.params as { slug: string };

    const { rows } = await app.controlDb.query(
      `SELECT
          sc.total_score,
          sc.criterion_demo_url,
          sc.criterion_features,
          sc.feature_breakdown,
          sc.scored_at,
          s.id AS submission_id,
          s.data,
          s.app_id,
          s.version,
          s.updated_at AS submitted_at,
          u.email AS user_email
       FROM hackathon_scores sc
       JOIN hackathon_submissions s ON s.id = sc.submission_id
       JOIN hackathons h ON h.id = sc.hackathon_id
       JOIN platform_users u ON u.id = sc.user_id
       WHERE h.slug = $1
       ORDER BY sc.total_score DESC, sc.scored_at ASC`,
      [slug]
    );

    // Dense ranking: ties get the same rank
    let rank = 0;
    let prevScore: number | null = null;
    const leaderboard = rows.map(row => {
      const score = Number(row.total_score);
      if (score !== prevScore) {
        rank++;
        prevScore = score;
      }
      return { rank, ...row };
    });

    return { leaderboard };
  });
}
