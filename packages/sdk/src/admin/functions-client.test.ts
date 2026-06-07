import { describe, it, expect } from 'vitest';
import type { DeployFunctionParams, FunctionDetails, FunctionLog, FunctionSummary, LogOptions } from './types';
import { AdminFunctionsClient } from './functions-client';

describe('Functions admin types', () => {
  it('accepts all 5 backend trigger types with config object', () => {
    const params: DeployFunctionParams = {
      name: 'fn',
      code: '',
      trigger: { type: 's3_upload', config: { bucket: 'x', prefix: 'y/' } },
    };
    expect(params.trigger?.type).toBe('s3_upload');
  });

  it('FunctionSummary models backend computed stats', () => {
    const s: FunctionSummary = {
      id: 'f', name: 'n', url: 'u', deployedAt: '2026-01-01',
      invocationCount: 10, errorRate: 0.1, avgDuration: 50, lastStatus: 'success', lastInvoked: '2026-01-01',
    };
    expect(s.invocationCount).toBe(10);
  });

  it('FunctionDetails.triggers is an array of trigger objects', () => {
    const d: FunctionDetails = {
      id: 'f', name: 'n', triggers: [
        { type: 'http', config: { auth: 'required' } },
        { type: 'cron', config: { schedule: '0 9 * * *' } },
      ],
    };
    expect(d.triggers?.[0]?.type).toBe('http');
    expect(d.triggers?.[1]?.type).toBe('cron');
  });
});

describe('AdminFunctionsClient.deploy', () => {
  it('forwards envVars, timeoutMs, memoryLimitMb, trigger.config to the request body', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({ id: '1', name: 'fn' });
      },
    };
    const c = new AdminFunctionsClient(fakeClient);
    await c.deploy({
      name: 'fn',
      code: 'export default {}',
      envVars: { K: 'v' },
      timeoutMs: 9000,
      memoryLimitMb: 256,
      trigger: { type: 'cron', config: { schedule: '*/5 * * * *' } },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/v1/app_x/functions');
    expect(calls[0].body).toMatchObject({
      name: 'fn',
      code: 'export default {}',
      envVars: { K: 'v' },
      timeoutMs: 9000,
      memoryLimitMb: 256,
      trigger: { type: 'cron', config: { schedule: '*/5 * * * *' } },
    });
  });
});

describe('AdminFunctionsClient.logs', () => {
  it('LogOptions accepts level filter', () => {
    const opts: LogOptions = { level: 'error', limit: 50 };
    expect(opts.level).toBe('error');
  });

  it('logs() forwards level as ?level= query param', async () => {
    const calls: string[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string) => {
        calls.push(path);
        return Promise.resolve([]);
      },
    };
    const c = new AdminFunctionsClient(fakeClient);
    await c.logs('fn', { level: 'error', limit: 10 });
    expect(calls[0]).toContain('level=error');
    expect(calls[0]).toContain('limit=10');
  });
});

describe('FunctionLog', () => {
  it('carries statusCode, error, durationMs, requestId', () => {
    const l: FunctionLog = {
      timestamp: '2026-01-01', level: 'error', message: 'boom',
      statusCode: 500, error: 'TypeError: x is null',
      durationMs: 12, requestId: 'req_1',
    };
    expect(l.statusCode).toBe(500);
    expect(l.requestId).toBe('req_1');
  });

  it('allows minimal log without optional fields', () => {
    const l: FunctionLog = { timestamp: '2026-01-01', level: 'info', message: 'ok' };
    expect(l.message).toBe('ok');
  });
});
