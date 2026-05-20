// services/control-api/src/__tests__/rls-validator.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { validateRlsPrerequisites } from '../services/rls-validator.js';
import { config } from '../config.js';

const testPool = new Pool({
  ...config.dataPlaneDb,
  database: 'test_rls_validation'
});

beforeAll(async () => {
  await testPool.query('CREATE TABLE IF NOT EXISTS test_table (id UUID PRIMARY KEY, user_id UUID, title TEXT)');
});

afterAll(async () => {
  await testPool.query('DROP TABLE IF EXISTS test_table');
  await testPool.end();
});

describe('RLS Validator', () => {
  it('should pass validation when table and column exist with correct type', async () => {
    const result = await validateRlsPrerequisites(testPool, 'test_table', 'user_id');

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should fail when table does not exist', async () => {
    const result = await validateRlsPrerequisites(testPool, 'nonexistent_table', 'user_id');

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_TABLE_NOT_FOUND');
    expect(result.error?.message).toContain('nonexistent_table');
  });

  it('should fail when column does not exist', async () => {
    const result = await validateRlsPrerequisites(testPool, 'test_table', 'nonexistent_column');

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_COLUMN_NOT_FOUND');
    expect(result.error?.remediation).toContain('apply_schema');
  });

  it('should fail when column is not UUID type', async () => {
    const result = await validateRlsPrerequisites(testPool, 'test_table', 'title');

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_INVALID_TYPE');
    expect(result.error?.message).toContain('UUID');
  });
});
