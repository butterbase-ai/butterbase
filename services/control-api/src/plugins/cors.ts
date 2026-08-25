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

// Endpoints any origin must be able to read for OAuth discovery to work from a
// browser-hosted client. RFC 9728 §3.1 and RFC 8414 §3 both say metadata
// endpoints should be publicly readable, and the MCP authorization spec assumes
// a browser client can complete discovery, registration and token exchange.
// Our normal policy is an allowlist backed by apps.allowed_origins, which blocks
// every third-party MCP client — including MCP Inspector on
// http://localhost:6274, the tool a marketplace reviewer is most likely to
// reach for. These responses carry no cookies and no ambient authority, so
// reflecting an arbitrary origin is safe as long as credentials stay off.
function isPublicOAuthPath(url: string): boolean {
  const path = url.split('?')[0];
  return path.startsWith('/.well-known/')
    || path === '/oauth/register'
    || path === '/oauth/token';
}

const PUBLIC_CORS: FastifyCorsOptions = {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  exposedHeaders: EXPOSED_HEADERS,
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
            // Returning `false` tells @fastify/cors to deny the origin without
            // throwing, which avoids turning CORS rejections into 500s.
            callback(null, false);
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
