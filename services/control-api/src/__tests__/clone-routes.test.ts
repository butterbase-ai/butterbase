import { describe, it, expect, vi } from 'vitest';

describe('GET /v1/clone-jobs/:job_id — warnings field', () => {
  it('round-trips warnings from the JSONB column', async () => {
    const controlDbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'cj_abc', status: 'completed',
          source_app_id: 'app_src', dest_app_id: 'app_dst',
          retry_count: 0, error_message: null,
          warnings: ['RLS policy "row_policy" references missing function get_user_id; skipped'],
          requested_by_user_id: 'usr_x',
          created_at: new Date('2026-06-01T00:00:00Z'),
          completed_at: new Date('2026-06-01T00:05:00Z'),
        }],
      }),
    };
    const { getCloneJob } = await import('../services/clone-jobs.js');
    const job = await getCloneJob(controlDbMock as any, 'cj_abc');
    expect(job?.warnings).toEqual(['RLS policy "row_policy" references missing function get_user_id; skipped']);
  });

  it('coerces null warnings to []', async () => {
    const controlDbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'cj_no_warn', status: 'completed',
          source_app_id: 'app_src', dest_app_id: 'app_dst',
          retry_count: 0, error_message: null, warnings: null,
          requested_by_user_id: 'usr_x',
          created_at: new Date(), completed_at: new Date(),
        }],
      }),
    };
    const { getCloneJob } = await import('../services/clone-jobs.js');
    const job = await getCloneJob(controlDbMock as any, 'cj_no_warn');
    expect((job?.warnings ?? []) as string[]).toEqual([]);
  });
});
