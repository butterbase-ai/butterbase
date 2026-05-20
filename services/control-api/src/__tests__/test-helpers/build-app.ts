import Fastify from 'fastify';
import { hackathonsMcpRoutes } from '../../routes/hackathons-mcp.js';
import { controlDb } from './control-db.js';

// Note: production typings already declare `request.auth: AuthContext` (via
// services/control-api/src/plugins/auth.ts) and `app.controlDb: pg.Pool` (via
// plugins/database.ts). We rely on those instead of redeclaring here to avoid
// a duplicate module augmentation.

export async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorate('controlDb', controlDb);
  app.addHook('onRequest', (req, _reply, done) => {
    const u = req.headers['x-test-user-id'];
    req.auth = {
      userId: typeof u === 'string' ? u : null,
      authMethod: 'api_key',
      scopes: ['*'],
    };
    done();
  });
  await app.register(hackathonsMcpRoutes);
  return app;
}
