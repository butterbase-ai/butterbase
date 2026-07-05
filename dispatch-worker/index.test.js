import { describe, it, expect, vi } from 'vitest';
import { parseKvValue, hashVisitor, beaconVisit } from './index.js';

describe('parseKvValue', () => {
  const env = { BUTTERBASE_REGION: 'us-east-1' };

  it('returns null for missing value', () => {
    expect(parseKvValue(null, env)).toBeNull();
  });

  it('parses JSON value', () => {
    expect(parseKvValue('{"appId":"a","region":"eu-west-1"}', env)).toEqual({ appId: 'a', region: 'eu-west-1' });
  });

  it('falls back to local region for JSON without region', () => {
    expect(parseKvValue('{"appId":"a"}', env)).toEqual({ appId: 'a', region: 'us-east-1' });
  });

  it('treats legacy string value as local region', () => {
    expect(parseKvValue('legacy-app-id', env)).toEqual({ appId: 'legacy-app-id', region: 'us-east-1' });
  });
});

describe('hashVisitor', () => {
  it('returns a stable 16-char hex for the same IP+UA', async () => {
    const a = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    const b = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different IPs', async () => {
    const a = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    const b = await hashVisitor('5.6.7.8', 'Mozilla/5.0');
    expect(a).not.toBe(b);
  });

  it('handles missing ip and UA gracefully', async () => {
    const a = await hashVisitor(null, null);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('beaconVisit', () => {
  it('no-ops silently when CONTROL_API_URL is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await beaconVisit({ BUTTERBASE_INTERNAL_SECRET: 'x' }, 'app1', '1.2.3.4', 'ua');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('no-ops silently when BUTTERBASE_INTERNAL_SECRET is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await beaconVisit({ CONTROL_API_URL: 'https://c/' }, 'app1', '1.2.3.4', 'ua');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('POSTs to /v1/internal/visit-beacon with the correct body and header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await beaconVisit(
      { CONTROL_API_URL: 'https://c.example', BUTTERBASE_INTERNAL_SECRET: 'sekret' },
      'app-123', '1.2.3.4', 'ua'
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://c.example/v1/internal/visit-beacon');
    expect(init.headers['x-butterbase-internal-secret']).toBe('sekret');
    const body = JSON.parse(init.body);
    expect(body.app_id).toBe('app-123');
    expect(body.count).toBe(1);
    expect(body.unique_hashes).toHaveLength(1);
    expect(body.unique_hashes[0]).toMatch(/^[0-9a-f]{16}$/);
    fetchSpy.mockRestore();
  });

  it('never throws when fetch rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(
      beaconVisit(
        { CONTROL_API_URL: 'https://c.example', BUTTERBASE_INTERNAL_SECRET: 'x' },
        'app', '1.2.3.4', 'ua'
      )
    ).resolves.not.toThrow();
    fetchSpy.mockRestore();
  });
});
