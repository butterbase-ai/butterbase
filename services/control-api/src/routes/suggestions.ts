import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, assertRegionConfig } from '../config.js';
import { requireAdmin } from './admin-auth.js';
import { sendSuggestionNotification, sendSuggestionStatusUpdateEmail } from '../services/auth/email-service.js';

const SUGGESTIONS_NOTIFICATION_EMAIL = process.env.SUGGESTIONS_NOTIFICATION_EMAIL;

function requireAdminSecret(request: FastifyRequest, reply: FastifyReply) {
  const secret = request.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    reply.code(403).send({ error: 'Invalid or missing admin secret' });
    return false;
  }
  return true;
}

async function checkAdminAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  // Try JWT first
  if (request.headers.authorization?.startsWith('Bearer ')) {
    const userId = await requireAdmin(app, request, reply);
    return userId !== null;
  }
  // Fall back to admin secret
  return requireAdminSecret(request, reply);
}

export async function suggestionsRoutes(app: FastifyInstance) {
  // ---------- Public (no auth) ----------

  app.post('/public/suggestions', {
    config: {
      public: true,
      rateLimit: {
        max: 3,
        timeWindow: '1 hour',
        keyGenerator: (req) => `public-suggestions:${req.ip}`,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      category?: unknown;
      description?: unknown;
      affected_tool?: unknown;
    };

    const validCategories = ['bug_report', 'feature_request', 'improvement', 'documentation'];
    if (typeof body.category !== 'string' || !validCategories.includes(body.category)) {
      return reply.code(400).send({ error: `category must be one of: ${validCategories.join(', ')}` });
    }
    if (typeof body.description !== 'string' || body.description.trim().length === 0) {
      return reply.code(400).send({ error: 'description is required' });
    }
    if (body.description.length > 4000) {
      return reply.code(400).send({ error: 'description must be 4000 characters or fewer' });
    }
    let affectedTool: string | null = null;
    if (body.affected_tool !== undefined && body.affected_tool !== null && body.affected_tool !== '') {
      if (typeof body.affected_tool !== 'string' || body.affected_tool.length > 200) {
        return reply.code(400).send({ error: 'affected_tool must be a string of 200 characters or fewer' });
      }
      affectedTool = body.affected_tool;
    }

    const { rows } = await app.controlDb.query(
      `INSERT INTO suggestions (category, severity, description, affected_tool, proposed_solution, context, source, api_key_id, user_id, app_id)
       VALUES ($1, NULL, $2, $3, NULL, $4, 'human_prompted', NULL, NULL, NULL)
       RETURNING id, status`,
      [
        body.category,
        body.description.trim(),
        affectedTool,
        JSON.stringify({ submitted_via: 'public_form', ip: request.ip }),
      ]
    );

    if (SUGGESTIONS_NOTIFICATION_EMAIL) {
      void sendSuggestionNotification(SUGGESTIONS_NOTIFICATION_EMAIL, {
        id: rows[0].id,
        category: body.category,
        severity: null,
        description: body.description.trim(),
        affected_tool: affectedTool,
        proposed_solution: null,
        source: 'human_prompted',
        user_id: null,
        user_email: null,
        app_id: null,
        app_name: null,
      });
    }

    return reply.code(201).send({ id: rows[0].id, status: rows[0].status });
  });

  // ---------- MCP / API-key authenticated ----------

  app.post('/suggestions', async (request, reply) => {
    const body = request.body as {
      category: string;
      description: string;
      severity?: string;
      affected_tool?: string;
      proposed_solution?: string;
      source?: string;
      app_id?: string;
      agent_context?: Record<string, unknown>;
    };

    const { category, description, severity, affected_tool, proposed_solution, source, app_id, agent_context } = body;

    if (!category || !description) {
      return reply.code(400).send({ error: 'category and description are required' });
    }

    const validCategories = ['bug_report', 'feature_request', 'improvement', 'documentation'];
    if (!validCategories.includes(category)) {
      return reply.code(400).send({ error: `category must be one of: ${validCategories.join(', ')}` });
    }

    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (severity && !validSeverities.includes(severity)) {
      return reply.code(400).send({ error: `severity must be one of: ${validSeverities.join(', ')}` });
    }

    const validSources = ['agent', 'human_prompted'];
    const resolvedSource = source && validSources.includes(source) ? source : 'agent';

    const apiKeyId = request.auth?.keyId ?? null;
    const userId = request.auth?.userId ?? null;

    // Auto-attach recent tool calls as context
    let recentToolCalls: unknown[] = [];
    if (apiKeyId) {
      try {
        const region = assertRegionConfig().instanceRegion;
        const { rows } = await app.runtimeDb(region).query(
          `SELECT tool_name, parameters, app_id, created_at
           FROM mcp_tool_call_log
           WHERE api_key_id = $1 AND created_at > now() - interval '1 hour'
           ORDER BY created_at DESC
           LIMIT 20`,
          [apiKeyId]
        );
        recentToolCalls = rows;
      } catch {
        // Non-critical
      }
    }

    const context = {
      recent_tool_calls: recentToolCalls,
      ...(agent_context ? { agent_context } : {}),
    };

    const { rows } = await app.controlDb.query(
      `INSERT INTO suggestions (category, severity, description, affected_tool, proposed_solution, context, source, api_key_id, user_id, app_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        category,
        severity ?? null,
        description,
        affected_tool ?? null,
        proposed_solution ?? null,
        JSON.stringify(context),
        resolvedSource,
        apiKeyId,
        userId,
        app_id ?? null,
      ]
    );

    // Resolve user email and app name for the notification email
    let userEmail: string | null = null;
    let appName: string | null = null;
    if (userId) {
      const { rows: userRows } = await app.controlDb.query(
        `SELECT email FROM platform_users WHERE id = $1`, [userId]
      );
      userEmail = userRows[0]?.email ?? null;
    }
    if (app_id) {
      const _region = assertRegionConfig().instanceRegion;
      const { rows: appRows } = await app.runtimeDb(_region).query(
        `SELECT name FROM apps WHERE id = $1`, [app_id]
      );
      appName = appRows[0]?.name ?? null;
    }

    if (SUGGESTIONS_NOTIFICATION_EMAIL) {
      void sendSuggestionNotification(SUGGESTIONS_NOTIFICATION_EMAIL, {
        ...rows[0],
        user_email: userEmail,
        app_name: appName,
      });
    }

    // Do NOT echo the captured `context` back to the client. It holds up to 20
    // recent tool calls with verbatim `parameters` (function source, html_content),
    // which can be tens of KB and blows past MCP per-tool-result limits. The
    // context is still persisted for the admin views (/admin/suggestions/:id).
    const { context: _context, ...suggestion } = rows[0];
    return reply.code(201).send({ suggestion });
  });

  // ---------- Admin-secret authenticated ----------

  app.get('/admin/suggestions', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdminAuth(app, request, reply))) return;

    const query = request.query as {
      status?: string;
      category?: string;
      affected_tool?: string;
      severity?: string;
      source?: string;
      sort_by?: string;
      sort_dir?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(query.offset ?? '0', 10) || 0;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(query.status);
    }
    if (query.category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(query.category);
    }
    if (query.affected_tool) {
      conditions.push(`affected_tool = $${paramIdx++}`);
      params.push(query.affected_tool);
    }
    if (query.severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(query.severity);
    }
    if (query.source) {
      conditions.push(`source = $${paramIdx++}`);
      params.push(query.source);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const SORT_MAP: Record<string, string> = {
      created_at: 'created_at',
      severity: `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
    };
    const sortKey = query.sort_by && query.sort_by in SORT_MAP ? query.sort_by : 'created_at';
    const sortDir = (query.sort_dir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = `ORDER BY ${SORT_MAP[sortKey]} ${sortDir}`;

    const [dataResult, countResult] = await Promise.all([
      app.controlDb.query(
        `SELECT s.*, pu.email AS user_email
         FROM suggestions s
         LEFT JOIN platform_users pu ON s.user_id = pu.id
         ${where} ${orderBy} LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      ),
      app.controlDb.query(
        `SELECT count(*)::int AS total FROM suggestions ${where}`,
        params
      ),
    ]);

    return {
      suggestions: dataResult.rows,
      total: countResult.rows[0]?.total ?? 0,
    };
  });

  app.patch('/admin/suggestions/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdminAuth(app, request, reply))) return;

    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };

    const validStatuses = ['new', 'acknowledged', 'in_progress', 'implemented', 'wont_fix'];
    if (!status || !validStatuses.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    // Single query: update status, capture previous status, and join user email
    const { rows } = await app.controlDb.query<{
      id: string;
      description: string;
      status: string;
      user_id: string | null;
      user_email: string | null;
      old_status: string;
      [key: string]: unknown;
    }>(
      `WITH prev AS (
         SELECT status AS old_status FROM suggestions WHERE id = $2
       ),
       updated AS (
         UPDATE suggestions SET status = $1, updated_at = now()
         WHERE id = $2
         RETURNING *
       )
       SELECT u.*, pu.email AS user_email, prev.old_status
       FROM updated u
       LEFT JOIN platform_users pu ON u.user_id = pu.id
       CROSS JOIN prev`,
      [status, id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Suggestion not found' });
    }

    const row = rows[0];

    // Notify the submitter only when there is a real user and the status actually changed
    if (row.user_id && row.user_email && row.status !== row.old_status) {
      void sendSuggestionStatusUpdateEmail(row.user_email, {
        id: row.id,
        description: row.description as string,
        status: row.status,
      });
    }

    // Strip the internal old_status field from the API response
    const { old_status: _, ...suggestion } = row;
    return { suggestion };
  });

  app.get('/admin/suggestions/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdminAuth(app, request, reply))) return;

    const { id } = request.params as { id: string };

    const { rows } = await app.controlDb.query(
      `SELECT s.*, pu.email AS user_email
       FROM suggestions s
       LEFT JOIN platform_users pu ON s.user_id = pu.id
       WHERE s.id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Suggestion not found' });
    }

    return { suggestion: rows[0] };
  });

  app.get('/admin/suggestions/stats', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdminAuth(app, request, reply))) return;

    const [byCategory, byStatus, byTool, total] = await Promise.all([
      app.controlDb.query(
        `SELECT category, count(*)::int AS count FROM suggestions GROUP BY category ORDER BY count DESC`
      ),
      app.controlDb.query(
        `SELECT status, count(*)::int AS count FROM suggestions GROUP BY status ORDER BY count DESC`
      ),
      app.controlDb.query(
        `SELECT affected_tool, count(*)::int AS count FROM suggestions
         WHERE affected_tool IS NOT NULL
         GROUP BY affected_tool ORDER BY count DESC LIMIT 20`
      ),
      app.controlDb.query(
        `SELECT count(*)::int AS total FROM suggestions`
      ),
    ]);

    return {
      total: total.rows[0]?.total ?? 0,
      by_category: byCategory.rows,
      by_status: byStatus.rows,
      by_tool: byTool.rows,
    };
  });
}
