import { ButterbaseError } from './base.js';

export class KvError extends ButterbaseError {
  constructor(message: string, code = 'KV_ERROR', status = 500, remediation?: string, details?: unknown) {
    super(message, code, status, remediation, details);
    this.name = 'KvError';
  }
}

export class KvAuthError extends KvError {
  constructor(m = 'unauthorized', c = 'KV_UNAUTHORIZED', s = 401, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvAuthError';
  }
}

export class KvForbiddenError extends KvError {
  constructor(m = 'forbidden', c = 'KV_FORBIDDEN', s = 403, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvForbiddenError';
  }
}

export class KvNotFoundError extends KvError {
  constructor(m = 'not found', c = 'KV_NOT_FOUND', s = 404, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvNotFoundError';
  }
}

export class KvKeyInvalidError extends KvError {
  constructor(m = 'invalid key', c = 'KV_KEY_INVALID', s = 400, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvKeyInvalidError';
  }
}

export class KvConnectionError extends KvError {
  constructor(m = 'connection error', c = 'KV_CONNECTION', s = 503, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvConnectionError';
  }
}
