import { describe, it, expect } from 'vitest';
import { buildPublicJobResponse } from './ai-videos.js';
import type { VideoJobRow } from '../services/ai-router/video-jobs.js';

// Route-level integration tests (happy-path submit/poll/content flows) are
// covered by the Task 9 E2E smoke tests that run against the deployed service
// via MCP. The helpers below are pure-function unit tests that need no Fastify
// instance, Postgres, or Redis.

function makeJob(overrides: Partial<VideoJobRow> = {}): VideoJobRow {
  return {
    id: 'job-abc',
    app_id: 'app-1',
    user_id: 'user-1',
    model: 'wan/t2v-turbo',
    status: 'completed',
    upstream_router: 'openrouter',
    upstream_job_id: 'upstream-xyz',
    upstream_polling_url: 'https://openrouter.ai/api/v1/generation/upstream-xyz',
    unsigned_urls: ['https://cdn.example.com/video.mp4'],
    error: null,
    lease_id: 'lease-1',
    estimated_cost_usd: '0.1000',
    provider_cost_usd: '0.0900',
    charged_credits_usd: '0.0990',
    markup_pct: '10.00',
    settled_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildPublicJobResponse', () => {
  it('returns expected shape for a completed job with unsigned_urls', () => {
    const job = makeJob();
    const res = buildPublicJobResponse('app-1', job);
    expect(res.job_id).toBe('job-abc');
    expect(res.status).toBe('completed');
    expect(res.model).toBe('wan/t2v-turbo');
    expect(res.polling_url).toBe('/v1/app-1/videos/completions/job-abc');
    expect(res.content_urls).toEqual(['/v1/app-1/videos/completions/job-abc/content?index=0']);
    expect(res.error).toBeNull();
    expect(res.created_at).toBeInstanceOf(Date);
  });

  it('returns null content_urls when unsigned_urls is null', () => {
    const job = makeJob({ unsigned_urls: null });
    const res = buildPublicJobResponse('app-1', job);
    expect(res.content_urls).toBeNull();
  });

  it('includes multiple content_urls when job has multiple videos', () => {
    const job = makeJob({
      unsigned_urls: ['https://cdn.example.com/v0.mp4', 'https://cdn.example.com/v1.mp4'],
    });
    const res = buildPublicJobResponse('app-1', job);
    expect(res.content_urls).toEqual([
      '/v1/app-1/videos/completions/job-abc/content?index=0',
      '/v1/app-1/videos/completions/job-abc/content?index=1',
    ]);
  });

  it('includes error field for a failed job', () => {
    const job = makeJob({ status: 'failed', error: 'upstream timeout', unsigned_urls: null });
    const res = buildPublicJobResponse('app-1', job);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('upstream timeout');
    expect(res.content_urls).toBeNull();
  });
});
