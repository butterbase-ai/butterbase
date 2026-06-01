import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

describe('clone-webhook-sweeper: computeSignature', () => {
  it('produces sha256=<hex> format', async () => {
    const { computeSignature } = await import('../services/clone-webhook-sweeper.js');
    const sig = computeSignature('my-secret', '{"event":"clone_completed"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expected = 'sha256=' + createHmac('sha256', 'my-secret')
      .update('{"event":"clone_completed"}')
      .digest('hex');
    expect(sig).toBe(expected);
  });
});

describe('clone-webhook-sweeper: runOnce', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('skips processing when no pending rows', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const { runOnce } = await import('../services/clone-webhook-sweeper.js');
    await runOnce(db as any, logger as any);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('delivers webhook and marks row delivered', async () => {
    const { encrypt } = await import('../services/crypto.js');
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    const encryptedSecret = encrypt('hook-secret', encKey);

    const outboxRow = {
      id: 'cwh_1', app_id: 'app_src', job_id: 'cj_abc',
      source_app_id: 'app_src', dest_app_id: 'app_dst', dest_region: 'us-east',
      completed_at: new Date('2026-06-01T00:05:00Z'), attempts: 0,
    };

    const webhookRow = {
      app_id: 'app_src',
      webhook_url: 'https://example.com/hook',
      webhook_secret_encrypted: encryptedSecret,
    };

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [outboxRow] })   // fetch pending
      .mockResolvedValueOnce({ rows: [webhookRow] })  // fetch webhook config
      .mockResolvedValue({ rows: [] });                // mark delivered

    const db = { query: queryMock };
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    const { runOnce } = await import('../services/clone-webhook-sweeper.js');
    await runOnce(db as any, logger as any);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Butterbase-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe('clone_completed');
    expect(body.job_id).toBe('cj_abc');
  });

  it('schedules retry after non-2xx (attempts < MAX)', async () => {
    const { encrypt } = await import('../services/crypto.js');
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;

    const outboxRow = {
      id: 'cwh_2', app_id: 'app_src', job_id: 'cj_def',
      source_app_id: 'app_src', dest_app_id: null, dest_region: 'us-east',
      completed_at: new Date(), attempts: 1,
    };

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [outboxRow] })
      .mockResolvedValueOnce({ rows: [{ app_id: 'app_src', webhook_url: 'https://x.com/hook', webhook_secret_encrypted: encrypt('s', encKey) }] })
      .mockResolvedValue({ rows: [] });

    fetchSpy.mockResolvedValue(new Response('bad', { status: 503 }));

    const { runOnce } = await import('../services/clone-webhook-sweeper.js');
    await runOnce({ query: queryMock } as any, logger as any);

    const updateCall = queryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('next_attempt_at') && !sql.includes('delivered_at'),
    );
    expect(updateCall).toBeDefined();
  });

  it('logs warn after 3 attempts (giving up)', async () => {
    const { encrypt } = await import('../services/crypto.js');
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;

    const outboxRow = {
      id: 'cwh_3', app_id: 'app_src', job_id: 'cj_ghi',
      source_app_id: 'app_src', dest_app_id: null, dest_region: 'us-east',
      completed_at: new Date(), attempts: 2, // next attempts === 3 ⇒ MAX
    };

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [outboxRow] })
      .mockResolvedValueOnce({ rows: [{ app_id: 'app_src', webhook_url: 'https://x.com', webhook_secret_encrypted: encrypt('s', encKey) }] })
      .mockResolvedValue({ rows: [] });

    fetchSpy.mockResolvedValue(new Response('err', { status: 500 }));

    const { runOnce } = await import('../services/clone-webhook-sweeper.js');
    await runOnce({ query: queryMock } as any, logger as any);
    expect(logger.warn).toHaveBeenCalled();
  });
});
