import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { healthRoutes } from '../routes/health.js';

const app = Fastify();

beforeAll(async () => {
  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(healthRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns ok when both databases are connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.controlDb).toBe('connected');
    expect(body.dataPlaneDb).toBe('connected');
  });
});
