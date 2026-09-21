import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../admin-auth.js';

// GET /admin/metrics/mcp-clients
//
// Which MCP client each user connected from — Claude Code, Cursor, Qoder,
// Codex, and so on.
//
// The signal is a by-product of the OAuth flow, not something we set out to
// collect. MCP clients register via DCR (RFC 7591), which carries a
// `client_name`; at token exchange, routes/oauth.ts names the minted key
// `OAuth: <client_name>`. So api_keys already holds a durable, per-user record
// of the connecting tool, going back to the first OAuth connection. This route
// only reads it.
//
// Two caveats travel with every number here:
//
//  1. `client_name` is SELF-REPORTED and unverified — a client can register
//     under any name it likes. Fine for marketing; not a trust boundary.
//  2. A key is not a user. DCR mints a fresh client_id per install/machine and
//     users re-connect after revoking, so keys >> users. `users` is the honest
//     column; `keys` is there to show how noisy the raw count is.
//
// This is NOT signup attribution: it says what someone connected with, not
// what brought them here. A user who found us via LinkedIn and then connected
// through Cursor appears under Cursor with signup_source=linkedin. See
// docs/marketing/mcp-attribution.md.

const INTERNAL_EMAIL_SUFFIX = '@butterbase.ai';
const TOP_N = 50;

function parseBool(v: unknown): boolean {
  return v === '1' || v === 'true' || v === true;
}

// The prefix routes/oauth.ts puts on every OAuth-minted key. Keys created by
// hand in the dashboard have no such prefix and must not be counted as MCP
// connections.
const OAUTH_KEY_PREFIX = 'OAuth: ';

const mcpClientsRoutes = async (app: FastifyInstance) => {
  app.get('/admin/metrics/mcp-clients', { config: { public: true } }, async (request, reply) => {
    const adminId = await requireAdmin(app, request, reply);
    if (!adminId) return;

    const q = request.query as Record<string, string | undefined>;
    const excludeInternal = parseBool(q.exclude_internal ?? '1');

    // Joined to platform_users only to honour the internal-email toggle that
    // every other admin metric offers; the counts come from api_keys.
    const internalJoin = excludeInternal
      ? `JOIN platform_users pu ON pu.id = k.user_id AND pu.email NOT ILIKE '%${INTERNAL_EMAIL_SUFFIX}'`
      : '';

    const res = await app.controlDb.query<{
      client: string;
      keys: string;
      users: string;
      first_seen: Date;
      last_seen: Date;
    }>(
      `SELECT
         regexp_replace(k.name, '^' || $1, '') AS client,
         count(*)::text AS keys,
         count(DISTINCT k.user_id)::text AS users,
         min(k.created_at) AS first_seen,
         max(k.created_at) AS last_seen
       FROM api_keys k
       ${internalJoin}
       WHERE k.name LIKE $1 || '%'
       GROUP BY 1
       ORDER BY count(DISTINCT k.user_id) DESC, count(*) DESC
       LIMIT ${TOP_N}`,
      [OAUTH_KEY_PREFIX]
    );

    const clients = res.rows.map((r) => ({
      client: r.client,
      keys: parseInt(r.keys, 10),
      users: parseInt(r.users, 10),
      first_seen: r.first_seen,
      last_seen: r.last_seen,
    }));

    return {
      exclude_internal: excludeInternal,
      // Summed distinct-user counts would double-count anyone who connected
      // from two different clients, so the total is reported over keys only
      // and the per-client `users` column is left to speak for itself.
      total_clients: clients.length,
      total_keys: clients.reduce((acc, c) => acc + c.keys, 0),
      clients,
    };
  });
};

export default mcpClientsRoutes;
