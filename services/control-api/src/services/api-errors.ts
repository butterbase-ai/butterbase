/**
 * Small taxonomy of typed errors so services can throw with intent and the
 * Fastify error handler in index.ts can map them to appropriate 4xx statuses
 * with agent-friendly response envelopes. Extends the app-resolver.ts pattern.
 *
 * Rules:
 *   - Throw these instead of `new Error(...)` when the failure is user-facing.
 *   - Keep `new Error(...)` for internal invariants / config / env checks
 *     (those legitimately deserve 500 + Sentry alerting).
 */

export class AuthorizationError extends Error {
  code: string;
  constructor(message: string, code = 'AUTH_FORBIDDEN') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export class NotFoundError extends Error {
  resourceType: string;
  constructor(resourceType: string, id?: string) {
    super(id ? `${resourceType} not found: ${id}` : `${resourceType} not found`);
    this.name = 'NotFoundError';
    this.resourceType = resourceType;
  }
}

export class ValidationError extends Error {
  code: string;
  constructor(message: string, code = 'VALIDATION_INVALID_INPUT') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export class ConflictError extends Error {
  code: string;
  constructor(message: string, code = 'RESOURCE_CONFLICT') {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}
