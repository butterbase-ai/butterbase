import { describe, it, expect } from 'vitest';
import { AdminEdgeSsrClient } from './edge-ssr-client';

describe('AdminEdgeSsrClient.streamBuildLogs', () => {
  it('hits the from-source logs route and forwards SSE events', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      requestStream: (m: string, p: string) => {
        calls.push({ m, p });
        return Promise.resolve(new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('event: log\ndata: building\n\n'));
            c.enqueue(new TextEncoder().encode('event: done\ndata: ok\n\n'));
            c.close();
          },
        }));
      },
    };
    const events: any[] = [];
    await new AdminEdgeSsrClient(fc).streamBuildLogs('d1', (e) => events.push(e));
    expect(calls[0]).toEqual({ m: 'GET', p: '/v1/app_x/edge-ssr/deployments/from-source/d1/logs' });
    expect(events).toEqual([
      { event: 'log', data: 'building' },
      { event: 'done', data: 'ok' },
    ]);
  });
});
