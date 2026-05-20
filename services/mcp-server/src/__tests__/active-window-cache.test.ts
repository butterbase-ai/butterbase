import { describe, it, expect, vi, afterEach } from 'vitest';
import { isActiveWindowCached, fetchAndCacheActiveWindow } from '../active-window-cache.js';

// Mock the api-client so we can control the base URL without a real server.
vi.mock('../api-client.js', () => ({
  getBaseUrl: () => 'http://localhost:4000',
}));

describe('active-window cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await fetchAndCacheActiveWindow();
    expect(result).toBe(false);
    expect(isActiveWindowCached()).toBe(false);
  });

  it('returns false when the endpoint returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({ error: 'no_active_hackathon' }),
    }));
    const result = await fetchAndCacheActiveWindow();
    expect(result).toBe(false);
    expect(isActiveWindowCached()).toBe(false);
  });

  it('returns true when hackathon is within its window', async () => {
    const starts_at = new Date(Date.now() - 1000).toISOString();
    const submission_deadline = new Date(Date.now() + 86_400_000).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ hackathon: { starts_at, submission_deadline } }),
    }));
    const result = await fetchAndCacheActiveWindow();
    expect(result).toBe(true);
    expect(isActiveWindowCached()).toBe(true);
  });

  it('returns false when past the submission deadline', async () => {
    const starts_at = new Date(Date.now() - 86_400_000).toISOString();
    const submission_deadline = new Date(Date.now() - 1000).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ hackathon: { starts_at, submission_deadline } }),
    }));
    const result = await fetchAndCacheActiveWindow();
    expect(result).toBe(false);
    expect(isActiveWindowCached()).toBe(false);
  });

  it('returns false when before the start date', async () => {
    const starts_at = new Date(Date.now() + 86_400_000).toISOString();
    const submission_deadline = new Date(Date.now() + 172_800_000).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ hackathon: { starts_at, submission_deadline } }),
    }));
    const result = await fetchAndCacheActiveWindow();
    expect(result).toBe(false);
    expect(isActiveWindowCached()).toBe(false);
  });
});
