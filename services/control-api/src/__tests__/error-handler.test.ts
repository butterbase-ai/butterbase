// services/control-api/src/__tests__/error-handler.test.ts
import { describe, it, expect } from 'vitest';
import { errors as joseErrors } from 'jose';
import { createAgentError, agentErrorFromEndUserJwtVerification } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA } from '@butterbase/shared/error-types';

describe('Error Handler', () => {
  it('should create structured error with all fields', () => {
    const error = createAgentError({
      code: RESOURCE_NOT_FOUND,
      message: 'App not found',
      remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
      documentation_url: 'https://docs.butterbase.ai/errors#resource-not-found'
    });

    expect(error).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'App not found',
        remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        documentation_url: 'https://docs.butterbase.ai/errors#resource-not-found'
      }
    });
  });

  it('should create error without optional documentation_url', () => {
    const error = createAgentError({
      code: VALIDATION_INVALID_SCHEMA,
      message: 'Schema validation failed',
      remediation: 'Check the schema format and try again.'
    });

    expect(error.error.documentation_url).toBeUndefined();
    expect(error.error.code).toBe('VALIDATION_INVALID_SCHEMA');
  });

  it('should include details when provided', () => {
    const error = createAgentError({
      code: VALIDATION_INVALID_SCHEMA,
      message: 'Schema validation failed',
      remediation: 'Fix the validation errors listed in details.',
      details: [{ field: 'name', error: 'Required' }]
    });

    expect(error.error.details).toEqual([{ field: 'name', error: 'Required' }]);
  });

  it('maps JWTExpired to AUTH_END_USER_JWT_EXPIRED', () => {
    const err = new joseErrors.JWTExpired('expired', { sub: 'u' }, 'exp', 'check_failed');
    const body = agentErrorFromEndUserJwtVerification(err);
    expect(body).not.toBeNull();
    expect(body!.error.code).toBe('AUTH_END_USER_JWT_EXPIRED');
  });

  it('maps other jose JOSEError to AUTH_INVALID_END_USER_JWT', () => {
    const err = new joseErrors.JWTInvalid('bad');
    const body = agentErrorFromEndUserJwtVerification(err);
    expect(body).not.toBeNull();
    expect(body!.error.code).toBe('AUTH_INVALID_END_USER_JWT');
  });

  it('returns null for non-jose errors', () => {
    expect(agentErrorFromEndUserJwtVerification(new Error('x'))).toBeNull();
  });
});
