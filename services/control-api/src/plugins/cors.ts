import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Always allow the platform dashboard, admin dashboard, and public submissions dashboard
      if (
        origin === config.dashboardUrl
        || origin === config.adminDashboardUrl
        || origin === config.submissionsDashboardUrl
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
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
};

export default fp(corsPlugin, {
  name: 'cors',
});
