// services/control-api/src/services/rls-validator.ts
import type { Pool } from 'pg';
import type { AgentFriendlyError } from '@butterbase/shared/types';
import { createAgentError, getDocUrl } from './error-handler.js';
import {
  VALIDATION_TABLE_NOT_FOUND,
  VALIDATION_COLUMN_NOT_FOUND,
  VALIDATION_INVALID_TYPE
} from '@butterbase/shared/error-types';

export interface ValidationResult {
  valid: boolean;
  error?: AgentFriendlyError['error'];
}

/**
 * Validates prerequisites for applying RLS to a table
 */
export async function validateRlsPrerequisites(
  pool: Pool,
  tableName: string,
  userColumn: string
): Promise<ValidationResult> {
  // Check if table exists
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = $1
    )`,
    [tableName]
  );

  if (!tableCheck.rows[0].exists) {
    return {
      valid: false,
      error: createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${tableName}" does not exist`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${tableName}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }).error
    };
  }

  // Check if column exists and get its type
  const columnCheck = await pool.query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     AND table_name = $1
     AND column_name = $2`,
    [tableName, userColumn]
  );

  if (columnCheck.rows.length === 0) {
    return {
      valid: false,
      error: createAgentError({
        code: VALIDATION_COLUMN_NOT_FOUND,
        message: `Column "${userColumn}" does not exist in table "${tableName}"`,
        remediation: `Add the user_column to your schema first. Use apply_schema to add: {"${userColumn}": {"type": "uuid", "nullable": false}}`,
        documentation_url: getDocUrl(VALIDATION_COLUMN_NOT_FOUND)
      }).error
    };
  }

  // Verify column is UUID or TEXT type
  const columnType = columnCheck.rows[0].udt_name;
  if (columnType !== 'uuid' && columnType !== 'text') {
    return {
      valid: false,
      error: createAgentError({
        code: VALIDATION_INVALID_TYPE,
        message: `Column "${userColumn}" must be UUID or TEXT type, but is ${columnType}`,
        remediation: `Change the column type to UUID or TEXT using apply_schema. The user_column must be compatible with the type returned by current_user_id().`,
        documentation_url: getDocUrl(VALIDATION_INVALID_TYPE)
      }).error
    };
  }

  return { valid: true };
}
