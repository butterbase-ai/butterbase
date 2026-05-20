// services/control-api/src/services/error-handler.ts
import type { AgentFriendlyError } from '@butterbase/shared/types';
import { errors as joseErrors } from 'jose';

interface ErrorOptions {
  code: string;
  message: string;
  remediation: string;
  documentation_url?: string;
  details?: unknown;
}

/**
 * Creates an agent-friendly error response
 */
export function createAgentError(options: ErrorOptions): AgentFriendlyError {
  const error: AgentFriendlyError = {
    error: {
      code: options.code,
      message: options.message,
      remediation: options.remediation,
    }
  };

  if (options.documentation_url) {
    error.error.documentation_url = options.documentation_url;
  }

  if (options.details !== undefined) {
    error.error.details = options.details;
  }

  return error;
}

/**
 * Documentation base URL
 */
const DOCS_BASE = 'https://docs.butterbase.ai';

/**
 * Generates documentation URL for error code
 */
export function getDocUrl(errorCode: string): string {
  const anchor = errorCode.toLowerCase().replace(/_/g, '-');
  return `${DOCS_BASE}/errors#${anchor}`;
}

/**
 * Helper to create common error responses
 */

/**
 * PostgreSQL constraint violation error codes
 */
export const PG_ERROR_CODES = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INSUFFICIENT_PRIVILEGE: '42501',
  INVALID_TEXT_REPRESENTATION: '22P02',
  INVALID_PARAMETER_VALUE: '22023',
  STRING_DATA_RIGHT_TRUNCATION: '22001',
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
  DATETIME_FIELD_OVERFLOW: '22008',
} as const;

const INVALID_INPUT_PG_CODES = new Set<string>([
  PG_ERROR_CODES.INVALID_TEXT_REPRESENTATION,
  PG_ERROR_CODES.INVALID_PARAMETER_VALUE,
  PG_ERROR_CODES.STRING_DATA_RIGHT_TRUNCATION,
  PG_ERROR_CODES.NUMERIC_VALUE_OUT_OF_RANGE,
  PG_ERROR_CODES.DATETIME_FIELD_OVERFLOW,
]);

/**
 * Detects PostgreSQL data-exception errors that indicate malformed user input
 * (class 22 — invalid JSON, bad numeric/date format, value too long, etc.).
 * These should map to 400 Bad Request, not 500.
 */
export function detectInvalidInput(error: unknown): {
  isInvalidInput: boolean;
  code?: string;
  detail?: string;
} {
  if (!(error instanceof Error)) return { isInvalidInput: false };
  const pgError = error as Error & { code?: string; detail?: string };
  if (pgError.code && INVALID_INPUT_PG_CODES.has(pgError.code)) {
    return { isInvalidInput: true, code: pgError.code, detail: pgError.detail };
  }
  return { isInvalidInput: false };
}

/**
 * True if the error already carries an HTTP statusCode (e.g. 401 from
 * requireUserId). Routes that wrap auth + business logic in a single try/catch
 * should rethrow these so Fastify's default handler honors the status — without
 * this, every 401 turns into a 500 + error-level log.
 */
export function isHttpError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

export function createInvalidInputError(pgCode: string, pgDetail?: string): AgentFriendlyError {
  return createAgentError({
    code: 'VALIDATION_INVALID_INPUT',
    message: pgDetail
      ? `Invalid input: ${pgDetail}`
      : 'Invalid input value for one or more fields',
    remediation:
      'Check that each field matches its column type. JSON columns require a JSON value (object/array), not a stringified array literal; numeric/date columns require properly formatted values.',
    documentation_url: getDocUrl('VALIDATION_INVALID_INPUT'),
    details: { pg_code: pgCode, pg_detail: pgDetail },
  });
}

/**
 * Detects PostgreSQL RLS / insufficient-privilege violations (SQLSTATE 42501)
 */
export function detectRlsViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const pgError = error as Error & { code?: string };
  return (
    pgError.code === PG_ERROR_CODES.INSUFFICIENT_PRIVILEGE ||
    error.message.includes('row-level security policy') ||
    error.message.includes('insufficient privilege')
  );
}

/**
 * Detects PostgreSQL constraint violations and returns structured error info
 */
export function detectConstraintViolation(error: unknown): {
  isConstraint: boolean;
  code?: string;
  constraintType?: 'unique' | 'foreign_key' | 'check' | 'not_null';
  details?: string;
  column?: string;
  tableName?: string;
} {
  if (!(error instanceof Error)) {
    return { isConstraint: false };
  }

  // Check for error code property (pg library adds these)
  const pgError = error as Error & {
    code?: string;
    constraint?: string;
    detail?: string;
    column?: string;
    table?: string;
  };

  if (pgError.code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
    return {
      isConstraint: true,
      code: pgError.code,
      constraintType: 'unique',
      details: pgError.detail || pgError.constraint || 'Duplicate key value violates unique constraint',
      column: pgError.column,
      tableName: pgError.table,
    };
  }

  if (pgError.code === PG_ERROR_CODES.FOREIGN_KEY_VIOLATION) {
    return {
      isConstraint: true,
      code: pgError.code,
      constraintType: 'foreign_key',
      details: pgError.detail || pgError.constraint || 'Foreign key constraint violation',
      column: pgError.column,
      tableName: pgError.table,
    };
  }

  if (pgError.code === PG_ERROR_CODES.CHECK_VIOLATION) {
    return {
      isConstraint: true,
      code: pgError.code,
      constraintType: 'check',
      details: pgError.detail || pgError.constraint || 'Check constraint violation',
      column: pgError.column,
      tableName: pgError.table,
    };
  }

  if (pgError.code === PG_ERROR_CODES.NOT_NULL_VIOLATION) {
    return {
      isConstraint: true,
      code: pgError.code,
      constraintType: 'not_null',
      details: pgError.detail || pgError.constraint || 'Not null constraint violation',
      column: pgError.column,
      tableName: pgError.table,
    };
  }

  // Fallback: check error message for constraint keywords
  if (error.message.includes('foreign key constraint')) {
    return {
      isConstraint: true,
      constraintType: 'foreign_key',
      details: error.message,
    };
  }

  if (error.message.includes('unique constraint') || error.message.includes('duplicate key')) {
    return {
      isConstraint: true,
      constraintType: 'unique',
      details: error.message,
    };
  }

  return { isConstraint: false };
}

/**
 * Maps jose errors from verifyEndUserJwt to a 401 agent error body, or null if unrelated.
 */
export function agentErrorFromEndUserJwtVerification(error: unknown): AgentFriendlyError | null {
  // Detect missing signing key (not a jose error, but an end-user auth error)
  if (error instanceof Error && error.name === 'EndUserSigningKeyNotFoundError') {
    return createAgentError({
      code: 'AUTH_INVALID_END_USER_JWT',
      message: 'End-user authentication is not configured for this app',
      remediation:
        'Configure OAuth or generate a signing key for this app before sending end-user JWTs. Use configure_oauth_provider to set up authentication.',
      documentation_url: getDocUrl('AUTH_INVALID_END_USER_JWT'),
    });
  }
  if (!(error instanceof joseErrors.JOSEError)) {
    return null;
  }
  if (error instanceof joseErrors.JWTExpired) {
    return createAgentError({
      code: 'AUTH_END_USER_JWT_EXPIRED',
      message: 'Your session has expired',
      remediation:
        'Sign in again or refresh your session to obtain a new end-user token, then retry the request.',
      documentation_url: getDocUrl('AUTH_END_USER_JWT_EXPIRED'),
    });
  }
  return createAgentError({
    code: 'AUTH_INVALID_END_USER_JWT',
    message: 'Invalid end-user authentication token',
    remediation:
      'Verify the Authorization Bearer token is a valid JWT issued for this app. If the token was altered or signed with a different key, sign in again to get a new token.',
    documentation_url: getDocUrl('AUTH_INVALID_END_USER_JWT'),
  });
}

/**
 * Creates agent-friendly error for constraint violations
 */
export function createConstraintViolationError(
  constraintType: 'unique' | 'foreign_key' | 'check' | 'not_null',
  details: string,
  meta?: { column?: string; tableName?: string }
): AgentFriendlyError {
  const col = meta?.column;
  const tbl = meta?.tableName;
  const colRef = col ? `'${col}'${tbl ? ` on table '${tbl}'` : ''}` : null;

  const errorMap = {
    unique: {
      code: 'VALIDATION_UNIQUE_CONSTRAINT_VIOLATION',
      message: colRef
        ? `Duplicate value for ${colRef} violates a unique constraint`
        : 'Duplicate value violates unique constraint',
      remediation: 'This record already exists. Use a different value for the unique field, or update the existing record instead.',
    },
    foreign_key: {
      code: 'VALIDATION_FOREIGN_KEY_VIOLATION',
      message: colRef
        ? `Foreign key constraint violation on column ${colRef}`
        : 'Foreign key constraint violation',
      remediation: 'The referenced record does not exist. Ensure all foreign key references point to existing records.',
    },
    check: {
      code: 'VALIDATION_CHECK_CONSTRAINT_VIOLATION',
      message: colRef
        ? `Check constraint violation on column ${colRef}`
        : 'Check constraint violation',
      remediation: 'The provided value does not meet the table\'s validation rules. Review the constraint details and adjust your input.',
    },
    not_null: {
      code: 'VALIDATION_NOT_NULL_VIOLATION',
      message: col
        ? `Column '${col}' is required and was not provided${tbl ? ` on table '${tbl}'` : ''}`
        : 'Required field is missing',
      remediation: col
        ? `Provide a value for '${col}', or set a default in the schema (e.g., "default": "gen_random_uuid()" for uuid columns, "default": "now()" for timestamps) so it auto-populates on insert.`
        : 'A required field was not provided. Include all non-nullable fields in your request, or set a default in the schema so the column auto-populates on insert.',
    },
  };

  const errorInfo = errorMap[constraintType];

  return createAgentError({
    code: errorInfo.code,
    message: errorInfo.message,
    remediation: errorInfo.remediation,
    documentation_url: getDocUrl(errorInfo.code),
    details: {
      constraint_details: details,
      ...(col ? { column: col } : {}),
      ...(tbl ? { table: tbl } : {}),
    },
  });
}

/**
 * Helper to create common error responses
 */
export const ErrorResponses = {
  resourceNotFound: (resourceType: string, identifier?: string) => createAgentError({
    code: 'RESOURCE_NOT_FOUND',
    message: identifier
      ? `${resourceType} "${identifier}" not found`
      : `${resourceType} not found`,
    remediation: `Verify the ${resourceType.toLowerCase()}_id is correct. Use list_${resourceType.toLowerCase()}s to see available ${resourceType.toLowerCase()}s.`,
    documentation_url: getDocUrl('RESOURCE_NOT_FOUND')
  }),

  validationError: (message: string, details?: unknown) => createAgentError({
    code: 'VALIDATION_INVALID_SCHEMA',
    message,
    remediation: 'Review the validation errors in the details field and correct your input.',
    documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
    details
  }),

  quotaExceeded: (quotaType: string, current: number, limit: number) => createAgentError({
    code: `QUOTA_${quotaType.toUpperCase()}_EXCEEDED`,
    message: `${quotaType} quota exceeded`,
    remediation: `Current usage: ${current}, Limit: ${limit}. Upgrade your plan or reduce usage.`,
    documentation_url: getDocUrl(`QUOTA_${quotaType.toUpperCase()}_EXCEEDED`)
  })
};
