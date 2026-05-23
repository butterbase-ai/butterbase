import type { FastifyInstance } from 'fastify';
import { resolveEligibility } from '../services/hackathons/eligibility.js';
import { HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX } from '../services/hackathons/open-for-submissions.js';
import { validateSubmissionData, getUrlFieldKey, type FieldSchema } from '../services/hackathons/field-schema.js';
import { verifyCode } from '../services/hackathons/codes.js';
import { scoreSubmission } from '../services/hackathons/scoring.js';

/**
 * Extract the subdomain from a `<sub>.butterbase.dev` URL, or null if the URL
 * isn't a (sub-of) butterbase.dev host. Used to auto-resolve app_id from the
 * participant's deployed-project URL.
 */
function extractButterbaseSubdomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'butterbase.dev' || !host.endsWith('.butterbase.dev')) return null;
  return host.slice(0, -'.butterbase.dev'.length) || null;
}

export async function hackathonsMcpRoutes(app: FastifyInstance) {
  /**
   * GET /hackathons/:slug/schema
   *
   * Returns a hackathon's field_schema and time metadata if the hackathon is
   * currently inside its submission window. Auth required (any signed-in user)
   * — the schema is not sensitive, but we don't expose it anonymously to keep
   * the MCP surface uniform. No "active" gate: multiple hackathons can be
   * open at once; callers identify the one they want by slug.
   */
  app.get('/hackathons/:slug/schema', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const { slug } = request.params as { slug: string };
    const { rows } = await app.controlDb.query<{
      slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
      field_schema: FieldSchema;
    }>(
      `SELECT slug, name, starts_at, ends_at, submission_deadline, field_schema
         FROM hackathons WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    const h = rows[0];

    const now = Date.now();
    if (now < new Date(h.starts_at).getTime() || now > new Date(h.submission_deadline).getTime()) {
      return reply.code(403).send({
        error: 'outside_submission_window',
        starts_at: h.starts_at,
        submission_deadline: h.submission_deadline,
      });
    }

    return {
      hackathon: {
        name: h.name,
        slug: h.slug,
        submission_deadline: h.submission_deadline,
        ends_at: h.ends_at,
      },
      field_schema: h.field_schema,
    };
  });

  /**
   * GET /v1/hackathons/active/my-submission
   *
   * Customer-dashboard endpoint. Returns the user's submission for the current
   * active hackathon (if any), plus their participant status.
   *
   * Response shape:
   *   {
   *     hackathon: { name, slug, field_schema, submission_deadline, ends_at } | null,
   *     submission: { fields, submitted_at, version } | null,
   *     participant_status: 'active' | 'revoked' | 'none'
   *   }
   */
  app.get('/hackathons/active/my-submission', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    reply.header('Cache-Control', 'private, max-age=30');

    const { rows: hRows } = await app.controlDb.query<{
      id: string; slug: string; name: string;
      ends_at: string; submission_deadline: string;
      field_schema: FieldSchema;
    }>(
      `SELECT id, slug, name, ends_at, submission_deadline, field_schema FROM hackathons
       ${HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX}`
    );

    if (hRows.length === 0) {
      return {
        hackathon: null,
        submission: null,
        participant_status: 'none' as const,
      };
    }

    const h = hRows[0];

    const { rows: pRows } = await app.controlDb.query<{ id: string; status: 'active' | 'revoked' }>(
      `SELECT id, status FROM hackathon_participants
       WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1`,
      [h.id, userId]
    );

    const hackathon = {
      name: h.name,
      slug: h.slug,
      field_schema: h.field_schema,
      submission_deadline: h.submission_deadline,
      ends_at: h.ends_at,
    };

    if (pRows.length === 0) {
      return {
        hackathon,
        submission: null,
        participant_status: 'none' as const,
      };
    }

    const participant = pRows[0];

    const { rows: sRows } = await app.controlDb.query<{
      data: Record<string, unknown>;
      version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT data, version, created_at, updated_at
       FROM hackathon_submissions
       WHERE hackathon_id = $1 AND participant_id = $2`,
      [h.id, participant.id]
    );

    return {
      hackathon,
      submission: sRows.length
        ? {
            fields: sRows[0].data,
            submitted_at: sRows[0].updated_at,
            version: sRows[0].version,
          }
        : null,
      participant_status: participant.status,
    };
  });

  /**
   * GET /hackathons/my-hackathons
   *
   * Returns all hackathons relevant to the authenticated user:
   *   - Any hackathon currently open for submissions (even if they haven't joined)
   *   - Any past hackathon where the user has a submission
   *
   * Ordered newest-first.
   */
  app.get('/hackathons/my-hackathons', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    reply.header('Cache-Control', 'private, max-age=30');

    const { rows } = await app.controlDb.query<{
      id: string; slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
      field_schema: FieldSchema;
      is_open: boolean;
      participant_status: 'active' | 'revoked' | null;
      submission_fields: Record<string, unknown> | null;
      submission_version: number | null;
      submitted_at: string | null;
    }>(
      `SELECT
         h.id, h.slug, h.name, h.starts_at, h.ends_at, h.submission_deadline, h.field_schema,
         (now() BETWEEN h.starts_at AND h.submission_deadline) AS is_open,
         p.status AS participant_status,
         s.data AS submission_fields,
         s.version AS submission_version,
         s.updated_at AS submitted_at
       FROM hackathons h
       LEFT JOIN hackathon_participants p ON p.hackathon_id = h.id AND p.user_id = $1
       LEFT JOIN hackathon_submissions s ON s.hackathon_id = h.id AND s.participant_id = p.id
       WHERE
         (now() BETWEEN h.starts_at AND h.submission_deadline)
         OR s.id IS NOT NULL
       ORDER BY h.starts_at DESC`,
      [userId]
    );

    return {
      hackathons: rows.map(r => ({
        hackathon: {
          slug: r.slug,
          name: r.name,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          submission_deadline: r.submission_deadline,
          field_schema: r.field_schema,
          is_open: r.is_open,
        },
        participant_status: r.participant_status ?? 'none',
        submission: r.submission_fields != null
          ? {
              fields: r.submission_fields,
              submitted_at: r.submitted_at!,
              version: r.submission_version!,
            }
          : null,
      })),
    };
  });

  app.get('/hackathons/active/my-status', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    reply.header('Cache-Control', 'private, max-age=30');

    const { rows: hRows } = await app.controlDb.query<{
      id: string; slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
    }>(
      `SELECT id, slug, name, starts_at, ends_at, submission_deadline FROM hackathons
       ${HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX}`
    );

    if (hRows.length === 0) {
      return { hackathon: null, eligible: false, reason: 'no_active_hackathon', submission: null };
    }

    const h = hRows[0];
    const elig = await resolveEligibility(app.controlDb, userId);

    if (!elig.eligible) {
      return { hackathon: h, eligible: false, reason: elig.reason, submission: null };
    }

    if (elig.eligible && elig.hackathon.id !== h.id) {
      return { hackathon: null, eligible: false, reason: 'no_active_hackathon' as const, submission: null };
    }

    const { rows: sRows } = await app.controlDb.query<{
      id: string; data: Record<string, unknown>; version: number; created_at: string; updated_at: string;
    }>(
      `SELECT id, data, version, created_at, updated_at
       FROM hackathon_submissions
       WHERE hackathon_id = $1 AND participant_id = $2`,
      [h.id, elig.participant_id]
    );

    return {
      hackathon: h,
      eligible: true,
      reason: null,
      submission: sRows.length ? sRows[0] : null,
    };
  });

  /**
   * POST /hackathons/resolve
   *
   * Resolve which open hackathon a caller is referring to without requiring a
   * slug. Resolution priority:
   *   1. submission_code matches exactly one open-window hackathon (argon2-verify)
   *   2. user is already an active participant in exactly one open-window hackathon
   *   3. only one hackathon is currently open → return it
   *
   * If none of those resolves a single hackathon, returns the list of open
   * hackathons so the caller can disambiguate with the user. This endpoint
   * exists to keep the MCP tool surface single-input ("just hand me the code")
   * even when several hackathons run concurrently.
   */
  app.post('/hackathons/resolve', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const body = (request.body ?? {}) as { submission_code?: string };

    const { rows: openRows } = await app.controlDb.query<{
      id: string; slug: string; name: string;
      starts_at: string; ends_at: string; submission_deadline: string;
      submission_code_hash: string; field_schema: FieldSchema;
    }>(
      `SELECT id, slug, name, starts_at, ends_at, submission_deadline,
              submission_code_hash, field_schema
         FROM hackathons
        WHERE starts_at <= now() AND now() <= submission_deadline
        ORDER BY starts_at DESC`
    );

    const openList = openRows.map(r => ({
      slug: r.slug, name: r.name,
      starts_at: r.starts_at, ends_at: r.ends_at,
      submission_deadline: r.submission_deadline,
    }));

    const toMatched = (r: typeof openRows[number]) => ({
      slug: r.slug,
      name: r.name,
      submission_deadline: r.submission_deadline,
      ends_at: r.ends_at,
      field_schema: r.field_schema,
    });

    if (openRows.length === 0) {
      return { matched: null, match_reason: null, open_hackathons: [] };
    }

    if (body.submission_code) {
      let hit: typeof openRows[number] | null = null;
      for (const r of openRows) {
        if (await verifyCode(body.submission_code, r.submission_code_hash)) {
          hit = r;
          break;
        }
      }
      if (hit) {
        return { matched: toMatched(hit), match_reason: 'submission_code', open_hackathons: openList };
      }
      return reply.code(401).send({
        error: 'invalid_submission_code',
        open_hackathons: openList,
        hint: 'No open hackathon accepted this submission_code. Confirm the code with the organizer or pick a hackathon from open_hackathons.',
      });
    }

    const { rows: pRows } = await app.controlDb.query<{ hackathon_id: string }>(
      `SELECT hackathon_id FROM hackathon_participants
        WHERE user_id = $1 AND status = 'active'
          AND hackathon_id = ANY($2::uuid[])`,
      [userId, openRows.map(r => r.id)]
    );
    if (pRows.length === 1) {
      const r = openRows.find(x => x.id === pRows[0].hackathon_id)!;
      return { matched: toMatched(r), match_reason: 'already_bound', open_hackathons: openList };
    }

    if (openRows.length === 1 && pRows.length === 0) {
      return { matched: toMatched(openRows[0]), match_reason: 'single_open', open_hackathons: openList };
    }

    return { matched: null, match_reason: null, open_hackathons: openList };
  });

  app.post('/hackathons/submissions', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const body = (request.body ?? {}) as {
      hackathon_slug?: string;
      submission_code?: string;
      data?: Record<string, unknown>;
      app_id?: string;
    };
    const data = body.data ?? {};

    const slug = body.hackathon_slug;
    const hackathonRow = slug
      ? await app.controlDb.query(
          `SELECT id, slug, starts_at, ends_at, submission_deadline,
                  submission_code_hash, field_schema
           FROM hackathons WHERE slug = $1`,
          [slug]
        )
      : await app.controlDb.query(
          `SELECT id, slug, starts_at, ends_at, submission_deadline,
                  submission_code_hash, field_schema
           FROM hackathons
           ${HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX}`
        );

    if (hackathonRow.rowCount === 0) {
      return reply.code(404).send({ error: 'no_active_hackathon' });
    }
    const h = hackathonRow.rows[0];

    const now = Date.now();
    if (now < new Date(h.starts_at).getTime() || now > new Date(h.submission_deadline).getTime()) {
      return reply.code(403).send({
        error: 'outside_submission_window',
        starts_at: h.starts_at,
        submission_deadline: h.submission_deadline,
      });
    }

    const { rows: pRows } = await app.controlDb.query<{ id: string; status: string }>(
      `SELECT id, status FROM hackathon_participants
       WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1`,
      [h.id, userId]
    );

    let participantId: string;
    let participantCreated = false;

    if (pRows.length > 0) {
      if (pRows[0].status === 'revoked') {
        return reply.code(403).send({ error: 'revoked' });
      }
      participantId = pRows[0].id;
    } else {
      if (!body.submission_code) {
        return reply.code(400).send({
          error: 'submission_code_required',
          hint: 'Ask the hackathon organizers for the current submission code and pass it as submission_code.',
        });
      }
      const ok = await verifyCode(body.submission_code, h.submission_code_hash);
      if (!ok) {
        return reply.code(401).send({ error: 'invalid_submission_code' });
      }
      const ins = await app.controlDb.query<{ id: string }>(
        `INSERT INTO hackathon_participants (hackathon_id, user_id, source, status)
         VALUES ($1, $2, 'mcp_self_register', 'active')
         ON CONFLICT (hackathon_id, user_id) DO UPDATE
           SET status = CASE WHEN hackathon_participants.status = 'revoked'
                              THEN hackathon_participants.status
                              ELSE 'active' END
         RETURNING id`,
        [h.id, userId]
      );
      participantId = ins.rows[0].id;
      participantCreated = true;
    }

    const validation = validateSubmissionData(h.field_schema, data);
    if (!validation.ok) {
      return reply.code(422).send({
        error: 'validation_failed',
        errors: validation.errors,
        field_schema: h.field_schema,
      });
    }

    // Resolve app_id: prefer an explicit body.app_id, otherwise try to derive
    // it from the participant's deployed-project URL. We look up
    // user_app_index (the cross-region authoritative app catalog) by the
    // URL's subdomain, scoped to the requesting user — so a participant can
    // only auto-bind to an app they own.
    let appId: string | null = body.app_id ?? null;
    if (!appId) {
      const urlKey = getUrlFieldKey(h.field_schema) ?? 'demo_url';
      const subdomain = extractButterbaseSubdomain(data[urlKey]);
      if (subdomain) {
        const { rows: appRows } = await app.controlDb.query<{ app_id: string }>(
          `SELECT app_id FROM user_app_index
            WHERE subdomain = $1 AND user_id = $2
            ORDER BY created_at DESC
            LIMIT 1`,
          [subdomain, userId]
        );
        if (appRows[0]) appId = appRows[0].app_id;
      }
    }

    const { rows } = await app.controlDb.query<{
      id: string; version: number; created_at: string; updated_at: string; data: Record<string, unknown>; app_id: string | null;
    }>(
      `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data, app_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (hackathon_id, participant_id) DO UPDATE
         SET data = EXCLUDED.data,
             app_id = EXCLUDED.app_id,
             version = hackathon_submissions.version + 1,
             updated_at = now()
       RETURNING id, version, created_at, updated_at, data, app_id`,
      [h.id, participantId, userId, JSON.stringify(data), appId]
    );

    const submissionRow = rows[0];

    // Fire-and-forget async scoring. Features live in the per-region runtime
    // DB (control plane only mirrors a subset post OSS-split), so route the
    // feature-count query to the app's home region. Fall back to controlDb
    // when there's no app_id — scoring still scores the URL criterion.
    setImmediate(async () => {
      try {
        const pool = submissionRow.app_id
          ? await app.runtimeDbForApp(submissionRow.app_id).catch(() => app.controlDb)
          : app.controlDb;
        await scoreSubmission(pool, {
          id: submissionRow.id,
          hackathon_id: h.id,
          participant_id: participantId,
          user_id: userId,
          data,
          app_id: submissionRow.app_id,
          field_schema: h.field_schema,
        }, request.log);
      } catch (err) {
        request.log.error({ err, submissionId: submissionRow.id }, '[hackathons] scoring dispatch failed');
      }
    });

    const isInsert = submissionRow.version === 1;
    return reply.code(isInsert ? 201 : 200).send({
      submission: {
        id: submissionRow.id,
        hackathon_slug: h.slug,
        version: submissionRow.version,
        created_at: submissionRow.created_at,
        updated_at: submissionRow.updated_at,
        data: submissionRow.data,
        app_id: submissionRow.app_id,
      },
      participant_created: participantCreated,
    });
  });
}
