import { describe, it, expect, vi } from 'vitest';
import { probeSpaRouting } from './spa-routing-probe.js';

function html200(body = '<!doctype html><div id="root"></div>'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function redirect(status: number, location: string): Response {
  return new Response('', { status, headers: { location } });
}

const noSleep = async () => {};

describe('probeSpaRouting', () => {
  it('returns ok when the probe URL responds with 200 + text/html', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html200());
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.contentType).toMatch(/text\/html/);
    }
  });

  it('fails on a 307 to / (the PR #33 regression symptom)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect(307, '/'));
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0, // single attempt for this case
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(307);
      expect(result.reason).toMatch(/expected status 200, got 307/);
      expect(result.reason).toMatch(/Location: \//);
    }
  });

  it('fails on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('fails on 200 with non-html content-type (e.g. served the wrong asset)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"foo": 1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected content-type text\/html/);
  });

  it('fails on 200 with no content-type at all', async () => {
    // Use a byte body so Node doesn't auto-set text/plain
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new TextEncoder().encode('whatever'), { status: 200 }),
    );
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected content-type text\/html/);
  });

  it('treats network errors as probe failures (with reason)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/network error: connect ECONNREFUSED/);
  });

  it('retries on transient failure and succeeds if a later attempt is healthy (WfP propagation race)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 })) // dispatcher hasn't seen new script yet
      .mockResolvedValueOnce(new Response('', { status: 404 })) // still propagating
      .mockResolvedValueOnce(html200()) // ok on 3rd try (deep-path probe passes)
      .mockResolvedValueOnce(html200()); // /index.html second probe
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 2,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports the LAST failure when all retries fail', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect(307, '/'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    const result = await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('appends a random probe path that cannot collide with real routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html200());
    await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toMatch(/^https:\/\/app\.example\.com\/__bb_route_probe_[0-9a-f]{16}$/);
  });

  it('handles a deploymentUrl with a trailing slash without doubling it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html200());
    await probeSpaRouting('https://app.example.com/', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).not.toMatch(/example\.com\/\//);
    expect(requestedUrl).toMatch(/^https:\/\/app\.example\.com\/__bb_route_probe_[0-9a-f]{16}$/);
  });

  it('passes redirect: manual so a 307 is observable instead of being followed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html200());
    await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: noSleep,
      retries: 0,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('observes the initial probeDelayMs before the first fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(html200());
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    await probeSpaRouting('https://app.example.com', {
      fetchImpl: fetchMock,
      sleep: sleepMock,
      probeDelayMs: 750,
      retries: 0,
    });
    // First sleep call must be the initial delay.
    expect(sleepMock).toHaveBeenCalledWith(750);
    expect(sleepMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
  });

  describe('/index.html second probe', () => {
    it('overall probe passes when deep-path and /index.html both return 200 + text/html', async () => {
      // First call: random deep-path probe; second call: /index.html probe.
      const fetchMock = vi.fn().mockResolvedValue(html200());
      const result = await probeSpaRouting('https://app.example.com', {
        fetchImpl: fetchMock,
        sleep: noSleep,
        retries: 0,
      });
      expect(result.ok).toBe(true);
      // Two fetches should have been made: deep-path + /index.html
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls[0]).toMatch(/__bb_route_probe_/);
      expect(urls[1]).toBe('https://app.example.com/index.html');
    });

    it('fails with INDEX_HTML_PROBE_FAILED when /index.html returns 404', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(html200()) // deep-path succeeds
        .mockResolvedValueOnce(new Response('', { status: 404 })); // /index.html 404
      const result = await probeSpaRouting('https://app.example.com', {
        fetchImpl: fetchMock,
        sleep: noSleep,
        retries: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INDEX_HTML_PROBE_FAILED');
        expect(result.status).toBe(404);
      }
    });

    it('fails with INDEX_HTML_PROBE_FAILED when /index.html returns non-text/html content-type', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(html200()) // deep-path succeeds
        .mockResolvedValueOnce(
          new Response('{"oops":1}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const result = await probeSpaRouting('https://app.example.com', {
        fetchImpl: fetchMock,
        sleep: noSleep,
        retries: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INDEX_HTML_PROBE_FAILED');
        expect(result.reason).toMatch(/expected content-type text\/html/);
      }
    });

    it('does not run /index.html probe if the deep-path probe already fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 })); // deep-path fails
      const result = await probeSpaRouting('https://app.example.com', {
        fetchImpl: fetchMock,
        sleep: noSleep,
        retries: 0,
      });
      expect(result.ok).toBe(false);
      // Only one fetch — /index.html probe is skipped when deep-path fails.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('strips a trailing slash from deploymentUrl before appending /index.html', async () => {
      const fetchMock = vi.fn().mockResolvedValue(html200());
      await probeSpaRouting('https://app.example.com/', {
        fetchImpl: fetchMock,
        sleep: noSleep,
        retries: 0,
      });
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls[1]).toBe('https://app.example.com/index.html');
      // Ensure no double-slash in the path portion (after the protocol)
      expect(urls[1].replace('https://', '')).not.toMatch(/\/\//);
    });
  });
});
