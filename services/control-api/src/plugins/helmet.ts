import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import helmet from '@fastify/helmet';

// API-only service: no HTML is ever rendered from these responses, so the
// web-oriented default CSP (font-src, img-src, style-src, etc.) would be
// misleading. useDefaults:false skips those. frame-ancestors 'none' layers
// on top of X-Frame-Options for modern browsers.
//
// All other helmet v8 defaults are appropriate as-is:
//   HSTS:             max-age=31536000; includeSubDomains  (1 year)
//   X-Content-Type-Options: nosniff
//   Referrer-Policy:  no-referrer
//   COOP/CORP:        same-origin
//   X-DNS-Prefetch-Control: off
const helmetPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    xFrameOptions: { action: 'deny' },
  });
};

export default fp(helmetPlugin, { name: 'helmet' });
