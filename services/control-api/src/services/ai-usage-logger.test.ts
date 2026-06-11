// services/control-api/src/services/ai-usage-logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRuntimePool = {
  query: vi.fn(),
};

vi.mock('./region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => mockRuntimePool),
}));

import { getAiUsageSummary } from './ai-usage-logger.js';

describe('getAiUsageSummary', () => {
  beforeEach(() => {
    mockRuntimePool.query.mockReset();
  });

  it('includes meetings breakdown from actor_usage_logs', async () => {
    // First query: ai_usage_logs (no rows)
    mockRuntimePool.query
      .mockResolvedValueOnce({ rows: [] })
      // Second query: actor_usage_logs with recording + transcription rows
      .mockResolvedValueOnce({
        rows: [
          { dimension: 'recording', total_seconds: '3600', total_usd: '0.5' },
          { dimension: 'transcription', total_seconds: '3600', total_usd: '0.15' },
        ],
      });

    const db = {} as any;
    const result = await getAiUsageSummary(db, 'app_1');

    expect(result.meetings).toHaveLength(2);
    expect(result.meetings).toContainEqual({ dimension: 'recording', seconds: 3600, usd: 0.5 });
    expect(result.meetings).toContainEqual({ dimension: 'transcription', seconds: 3600, usd: 0.15 });
  });

  it('returns empty meetings array when no actor_usage_logs rows', async () => {
    mockRuntimePool.query
      .mockResolvedValueOnce({ rows: [] })  // ai_usage_logs
      .mockResolvedValueOnce({ rows: [] }); // actor_usage_logs

    const db = {} as any;
    const result = await getAiUsageSummary(db, 'app_1');

    expect(result.meetings).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});
