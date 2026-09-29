import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { FastifyCorsOptions } from '@fastify/cors';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';

// `WWW-Authenticate` is not a CORS-safelisted response header, so without this a
// browser client cannot read the 401 challenge — and that challenge is what
// carries `resource_metadata`, the entry point to the whole discovery flow.
const EXPOSED_HEADERS = ['WWW-Authenticate', 'Mcp-Session-Id'];

// Chromium's cap on Access-Control-Max-Age — anything higher gets silently
// clamped. Without this, every non-simple browser request (the SDK always
// sends Content-Type: application/json) pays a full preflight round trip.
const PREFLIGHT_MAX_AGE_SECONDS = 7200;

// Passed as the "resolved origin" for a request whose origin failed the
// allowlist check. It must be truthy (unlike `false`) so @fastify/cors still
// treats this request as CORS-participating and completes the OPTIONS
// preflight with 204 instead of falling through to its wildcard OPTIONS
// route, which 404s when no request has marked itself CORS-enabled. Because
// it is an empty array, @fastify/cors's own origin-matching (which checks
// membership) never finds the actual request origin in it, so
// Access-Control-Allow-Origin is correctly left off the response — the
// allowlist check itself is unchanged.
const NO_ORIGIN_MATCH: string[] = [];

// Endpoints any origin must be able to read for OAuth discovery to work from a
// browser-hosted client. RFC 9728 §3.1 and RFC 8414 §3 both say metadata
// endpoints should be publicly readable, and the MCP authorization spec assumes
// a browser client can complete discovery, registration and token exchange.
// Our normal policy is an allowlist backed by apps.allowed_origins, which blocks
// every third-party MCP client — including MCP Inspector on
// http://localhost:6274, the tool a marketplace reviewer is most likely to
// reach for. These responses carry no cookies and no ambient authority, so
// reflecting an arbitrary origin is safe as long as credentials stay off.
// `/mcp` is included deliberately. Discovery, registration and token exchange
// are useless to a browser client if the endpoint it was all for stays behind
// the allowlist — the client would authenticate successfully and then be unable
// to call a single tool. `/mcp` authenticates with an explicit Authorization
// header and never with cookies, so with credentials off there is no ambient
// authority for a hostile page to borrow; it would still need a token it does
// not have.
function isPublicOAuthPath(url: string): boolean {
  const path = url.split('?')[0];
  return path.startsWith('/.well-known/')
    || path === '/oauth/register'
    || path === '/oauth/token'
    || path === '/mcp';
}

const PUBLIC_CORS: FastifyCorsOptions = {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
  exposedHeaders: EXPOSED_HEADERS,
  maxAge: PREFLIGHT_MAX_AGE_SECONDS,
};

function defaultCorsOptions(fastify: FastifyInstance): FastifyCorsOptions {
  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Always allow the platform dashboard, admin dashboard, public submissions
      // dashboard, and Office
      if (
        origin === config.dashboardUrl
        || origin === config.adminDashboardUrl
        || origin === config.submissionsDashboardUrl
        || origin === config.officeUrl
        || origin === config.templatesUrl
      ) {
        callback(null, true);
        return;
      }

      // Allow any *.butterbase.dev subdomain origin
      if (config.subdomain.enabled) {
        try {
          const url = new URL(origin);
          if (url.hostname.endsWith(`.${config.subdomain.baseDomain}`)) {
            callback(null, true);
            return;
          }
        } catch {
          // invalid origin URL, fall through to DB check
        }
      }

      // Check if origin is allowed for any app — apps are per-region, so we
      // scan every configured region's runtime DB. Allow if any region finds
      // a match. Callback-style; do not return a Promise.
      const regions = Object.keys(config.runtimeDb.urlsByRegion);
      Promise.all(
        regions.map((r) =>
          getRuntimeDbPool(config.runtimeDb, r)
            .query(`SELECT 1 FROM apps WHERE $1 = ANY(allowed_origins) LIMIT 1`, [origin])
            .then((res) => res.rows.length > 0),
        ),
      )
        .then((matches) => {
          if (matches.some(Boolean)) {
            callback(null, true);
          } else {
            // NO_ORIGIN_MATCH denies the origin (no Access-Control-Allow-Origin
            // is emitted) without throwing, which avoids turning CORS
            // rejections into 500s, and without returning `false`, which would
            // make @fastify/cors 404 an OPTIONS preflight instead of replying
            // 204.
            callback(null, NO_ORIGIN_MATCH);
          }
        })
        .catch((error) => {
          fastify.log.error({ error, origin }, 'CORS check failed');
          callback(error as Error, false);
        });
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Signup-Source',
      'X-Signup-Referrer',
      'X-Organization-Id',
      'X-Butterbase-As-User',
    ],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
}

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  const fallback = defaultCorsOptions(fastify);
  await fastify.register(cors, {
    delegator: (req, callback) => {
      callback(null, isPublicOAuthPath(req.url ?? '') ? PUBLIC_CORS : fallback);
    },
  });
};

export default fp(corsPlugin, {
  name: 'cors',
});
