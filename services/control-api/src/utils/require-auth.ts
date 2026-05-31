import type { FastifyRequest } from 'fastify';

/**
 * Extracts userId from request auth, throwing 401 if not authenticated.
 * Use in route handlers that require a logged-in platform user.
 */
export function requireUserId(request: FastifyRequest): string {
  const userId = request.auth.userId;
  if (!userId) {
    const error = new Error('Authentication required') as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  return userId;
}

/** Returns the authenticated platform user id, or null if anonymous. Does not throw. */
export function tryGetUserId(request: FastifyRequest): string | null {
  try {
    return requireUserId(request);
  } catch {
    return null;
  }
}
