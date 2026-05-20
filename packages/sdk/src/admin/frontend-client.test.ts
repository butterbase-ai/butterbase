import { describe, it, expect } from 'vitest';
import { AdminFrontendClient } from './frontend-client';
import type { CreateDeploymentParams, DeploymentCreateResponse, FrontendFromSourceCreateResult, FrontendFromSourceStartResult } from './types';

describe('CreateDeploymentParams', () => {
  it('only accepts framework', () => {
    const p: CreateDeploymentParams = { framework: 'react-vite' };
    expect(p.framework).toBe('react-vite');
  });

  it('framework values are the four backend enum', () => {
    const a: CreateDeploymentParams = { framework: 'nextjs-static' };
    const b: CreateDeploymentParams = { framework: 'static' };
    const c: CreateDeploymentParams = { framework: 'other' };
    expect([a, b, c].every((x) => typeof x.framework === 'string')).toBe(true);
  });
});

describe('AdminFrontendClient.createDeployment', () => {
  it('returns presigned upload metadata, not Deployment', async () => {
    const fc: any = {
      appId: 'app_x',
      request: () => Promise.resolve<DeploymentCreateResponse>({
        id: 'd1', uploadUrl: 'https://x', expiresIn: 900, maxSizeBytes: 1_000_000,
      }),
    };
    const r = await new AdminFrontendClient(fc).createDeployment({ framework: 'react-vite' });
    expect(r.data?.uploadUrl).toMatch(/^https/);
    expect(r.data?.id).toBe('d1');
  });

  it('forwards framework in POST body', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push({ m, p, body }); return Promise.resolve({ id: 'd', uploadUrl: 'u', expiresIn: 1, maxSizeBytes: 1 }); },
    };
    await new AdminFrontendClient(fc).createDeployment({ framework: 'static' });
    expect(calls[0]).toMatchObject({
      m: 'POST',
      p: '/v1/app_x/frontend/deployments',
      body: { framework: 'static' },
    });
  });

  it('createDeployment with no args works (framework optional)', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push(body); return Promise.resolve({ id: 'd', uploadUrl: 'u', expiresIn: 1, maxSizeBytes: 1 }); },
    };
    await new AdminFrontendClient(fc).createDeployment();
    expect(calls[0]).toEqual({});
  });
});

describe('AdminFrontendClient from-source', () => {
  it('createFromSource POSTs the from-source create route', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => {
        calls.push({ m, p, body });
        return Promise.resolve<FrontendFromSourceCreateResult>({
          deployment_id: 'd1', build_id: 'b1', upload_url: 'https://u', max_source_bytes: 1e8,
        });
      },
    };
    const r = await new AdminFrontendClient(fc).createFromSource();
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/v1/app_x/frontend/deployments/from-source', body: {} });
    expect(r.data?.upload_url).toBe('https://u');
  });

  it('startFromSource POSTs build params to /:id/start', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => {
        calls.push({ m, p, body });
        return Promise.resolve<FrontendFromSourceStartResult>({
          build_id: 'b1', status: 'building', logs_url: 'L', status_url: 'S',
        });
      },
    };
    const params = {
      buildCommand: 'npm run build',
      outputDir: 'dist',
      packageManager: 'npm' as const,
      lockfileHash: 'abcdef0123456789abcdef0123456789',
    };
    const r = await new AdminFrontendClient(fc).startFromSource('d1', params);
    expect(calls[0]).toMatchObject({
      m: 'POST',
      p: '/v1/app_x/frontend/deployments/from-source/d1/start',
      body: params,
    });
    expect(r.data?.build_id).toBe('b1');
  });

  it('streamBuildLogs consumes SSE and forwards events', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      requestStream: (m: string, p: string) => {
        calls.push({ m, p });
        return Promise.resolve(new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('event: log\ndata: hello\n\n'));
            c.enqueue(new TextEncoder().encode('event: done\ndata: ok\n\n'));
            c.close();
          },
        }));
      },
    };
    const events: any[] = [];
    await new AdminFrontendClient(fc).streamBuildLogs('d1', (e) => events.push(e));
    expect(calls[0]).toEqual({ m: 'GET', p: '/v1/app_x/frontend/deployments/from-source/d1/logs' });
    expect(events).toEqual([
      { event: 'log', data: 'hello' },
      { event: 'done', data: 'ok' },
    ]);
  });
});
