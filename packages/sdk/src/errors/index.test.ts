import { describe, it, expect } from 'vitest';
import {
  parseApiError, ButterbaseError,
  AuthError, ValidationError, NotFoundError, QuotaError, NetworkError,
} from './index';

describe('parseApiError — code-driven', () => {
  it('AUTH_INVALID_API_KEY → AuthError', () => {
    const e = parseApiError(401, { error: { code: 'AUTH_INVALID_API_KEY', message: 'bad key', remediation: 'check the key' } });
    expect(e).toBeInstanceOf(AuthError);
    expect(e.code).toBe('AUTH_INVALID_API_KEY');
    expect(e.remediation).toBe('check the key');
    expect(e.status).toBe(401);
  });

  it('VALIDATION_INVALID_SCHEMA → ValidationError', () => {
    const e = parseApiError(400, { error: { code: 'VALIDATION_INVALID_SCHEMA', message: 'bad schema', remediation: 'fix the schema' } });
    expect(e).toBeInstanceOf(ValidationError);
  });

  it('RESOURCE_NOT_FOUND → NotFoundError', () => {
    const e = parseApiError(404, { error: { code: 'RESOURCE_NOT_FOUND', message: 'nope', remediation: 'check the resource id' } });
    expect(e).toBeInstanceOf(NotFoundError);
  });

  it('QUOTA_* prefix → QuotaError', () => {
    const e = parseApiError(429, { error: { code: 'QUOTA_FILE_SIZE_EXCEEDED', message: 'too big', remediation: 'reduce file size' } });
    expect(e).toBeInstanceOf(QuotaError);
  });

  it('EXTERNAL_* prefix → NetworkError', () => {
    const e = parseApiError(502, { error: { code: 'EXTERNAL_CLOUDFLARE_ERROR', message: 'CF down', remediation: 'retry later' } });
    expect(e).toBeInstanceOf(NetworkError);
  });
});

describe('parseApiError — fallback', () => {
  it('falls back to status for unknown agent shape', () => {
    expect(parseApiError(401, {})).toBeInstanceOf(AuthError);
    expect(parseApiError(404, {})).toBeInstanceOf(NotFoundError);
    expect(parseApiError(500, {})).toBeInstanceOf(ButterbaseError);
  });

  it('extracts legacy { error: "string" } message', () => {
    const e = parseApiError(400, { error: 'oops' });
    expect(e.message).toBe('oops');
    expect(e.code).toBe('HTTP_400');
    expect(e).toBeInstanceOf(ValidationError);
  });

  it('preserves details', () => {
    const e = parseApiError(400, { error: { code: 'VALIDATION_INVALID_SCHEMA', message: 'bad', remediation: 'fix it', details: { field: 'name' } } });
    expect(e.details).toEqual({ field: 'name' });
  });
});
