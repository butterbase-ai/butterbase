import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestLeaseFromPlatform, settleLeaseFromPlatform } from './lease-client.js';

beforeEach(() => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  process.env.BUTTERBASE_PLATFORM_REGION = 'us-east-1';
  process.env.BUTTERBASE_REGION = 'eu-west-1';
});

describe('requestLeaseFromPlatform', () => {
  it('POSTs to the platform region with auth header', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      leaseId: 'abc', amountGranted: 1, expiresAt: new Date(Date.now() + 300000).toISOString(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await requestLeaseFromPlatform({
      userId: 'u1',
      amountUsd: 1,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://platform-api:4000/v1/internal/lease/grant');
    expect((init as RequestInit).headers).toMatchObject({ 'x-butterbase-internal-secret': 'test-secret' });
    expect(r.amountGranted).toBe(1);
    expect(r.leaseId).toBe('abc');
  });

  it('throws on non-200 responses', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(requestLeaseFromPlatform({
      userId: 'u1',
      amountUsd: 1,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: fetcher,
    })).rejects.toThrow(/lease grant failed: 500/);
  });
});

describe('settleLeaseFromPlatform', () => {
  it('POSTs to /v1/internal/lease/:id/settle with auth header and body', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ refundedUsd: 2.5 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const r = await settleLeaseFromPlatform({
      leaseId: 'abc-123',
      actualUsd: 1.5,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://platform-api:4000/v1/internal/lease/abc-123/settle');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'x-butterbase-internal-secret': 'test-secret' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ actualUsd: 1.5 });
    expect(r.refundedUsd).toBe(2.5);
  });

  it('URL-encodes the lease id', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ refundedUsd: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await settleLeaseFromPlatform({
      leaseId: 'has/slash',
      actualUsd: 0,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: fetcher,
    });
    const [url] = fetcher.mock.calls[0];
    expect(url).toBe('http://platform-api:4000/v1/internal/lease/has%2Fslash/settle');
  });

  it('throws on non-200 responses', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(settleLeaseFromPlatform({
      leaseId: 'missing',
      actualUsd: 1,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: fetcher,
    })).rejects.toThrow(/lease settle failed: 404/);
  });

  it('throws when BUTTERBASE_INTERNAL_SECRET is missing', async () => {
    delete process.env.BUTTERBASE_INTERNAL_SECRET;
    await expect(settleLeaseFromPlatform({
      leaseId: 'x',
      actualUsd: 1,
      platformControlApiUrl: 'http://platform-api:4000',
      fetch: vi.fn(),
    })).rejects.toThrow(/BUTTERBASE_INTERNAL_SECRET required/);
  });
});
