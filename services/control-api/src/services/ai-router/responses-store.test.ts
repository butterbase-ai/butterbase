import { describe, it, expect } from 'vitest';
import {
  loadResponseRow, insertResponseRow, generateResponseId, DEFAULT_TTL_SECONDS,
} from './responses-store.js';
import { Pool } from 'pg';

describe('responses-store', () => {
  it('generateResponseId returns rsp_ prefix', () => {
    const id = generateResponseId();
    expect(id).toMatch(/^rsp_[0-9a-z]{26}$/);
  });

  describe.skipIf(!process.env.TEST_RUNTIME_DB_URL)('DB round-trip', () => {
    it('insert + load round-trips a row', async () => {
      const pool = new Pool({ connectionString: process.env.TEST_RUNTIME_DB_URL });
      const id = generateResponseId();
      const now = Math.floor(Date.now() / 1000);
      await insertResponseRow(pool, {
        id, createdAt: now, previousResponseId: null,
        model: 'openai/gpt-4o', inputMessages: [{ role: 'user', content: 'hi' }],
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi back' }] }],
        usage: { input_tokens: 1, output_tokens: 2 },
        status: 'completed', expiresAt: now + DEFAULT_TTL_SECONDS,
      });
      const row = await loadResponseRow(pool, id);
      expect(row?.model).toBe('openai/gpt-4o');
      expect((row?.output as any[])[0].content[0].text).toBe('hi back');
      await pool.end();
    });
  });
});
