import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../../services/auth/signing-key-service.js', () => ({
  getPublicKeysForJwks: vi.fn(async (_db: unknown, appId: string) => {
    const { AppNotFoundError } = await import('../../../services/app-resolver.js');
    throw new AppNotFoundError(appId);
  }),
}));

import { jwksRoutes } from '../jwks.js';
import {
  AppNotFoundError,
  AppPausedError,
  rethrowAppResolverError,
} from '../../../services/app-resolver.js';

describe('rethrowAppResolverError', () => {
  it('rethrows typed app-resolver errors', () => {
    expect(() => rethrowAppResolverError(new AppNotFoundError('app_x'))).toThrow(AppNotFoundError);
    expect(() => rethrowAppResolverError(new AppPausedError('app_x', null))).toThrow(AppPausedError);
  });

  it('ignores other errors', () => {
    expect(() => rethrowAppResolverError(new Error('db down'))).not.toThrow();
    expect(() => rethrowAppResolverError('nope')).not.toThrow();
  });
});

describe('auth route catch blocks', () => {
  it('let AppNotFoundError reach the global handler instead of answering 500', async () => {
    const app = Fastify();
    (app as any).decorate('controlDb', {});
    // Mirrors index.ts: typed resolver errors map to 404.
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppNotFoundError) return reply.status(404).send({ error: error.message });
      return reply.status(500).send({ error: 'Internal server error' });
    });
    await app.register(jwksRoutes);

    const res = await app.inject({ method: 'GET', url: '/auth/app_missing/.well-known/jwks.json' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('app_missing');
    await app.close();
  });
});
