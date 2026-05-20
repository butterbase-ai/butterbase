import fp from 'fastify-plugin';
import pg from 'pg';
import { config } from '../config.js';
import { resolveActivePlatformDbUrl } from '../services/platform-db.js';

declare module 'fastify' {
  interface FastifyInstance {
    controlDb: pg.Pool;
  }
}

export const databasePlugin = fp(
  async (app) => {
    // Intentionally constructing a fresh pool here rather than using a shared singleton:
    // this plugin owns the pool lifecycle and calls pool.end() in its onClose hook.
    // A shared singleton would be torn down for the entire process when the plugin closes.
    const pool = new pg.Pool({
      connectionString: resolveActivePlatformDbUrl(config.platformDb),
      max: 150,
      idleTimeoutMillis: 10000,   // Release idle connections before Neon's proxy kills them
      connectionTimeoutMillis: 10000,
    });

    // Evict dead connections so they don't poison subsequent queries
    pool.on('error', (err) => {
      app.log.warn({ err: err.message }, 'Control DB pool background connection error (evicted)');
    });

    app.decorate('controlDb', pool);

    app.addHook('onClose', async () => {
      await pool.end();
    });
  },
  { name: 'database' }
);
