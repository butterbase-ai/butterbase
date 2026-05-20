import fp from 'fastify-plugin';
import pg from 'pg';
import { config } from '../config.js';
import { closeAllPools } from '../services/app-pool.js';

declare module 'fastify' {
  interface FastifyInstance {
    dataPlaneDb: pg.Pool;
  }
}

export const dataPlanePlugin = fp(
  async (app) => {
    const pool = new pg.Pool({
      host: config.dataPlaneDb.host,
      port: config.dataPlaneDb.port,
      user: config.dataPlaneDb.user,
      password: config.dataPlaneDb.password,
      database: 'postgres',
      max: 3,
    });

    pool.on('error', (err) => {
      app.log.warn({ err: err.message }, 'Data-plane DB pool background connection error (evicted)');
    });

    app.decorate('dataPlaneDb', pool);

    app.addHook('onClose', async () => {
      await closeAllPools();
      await pool.end();
    });
  },
  { name: 'data-plane' }
);
