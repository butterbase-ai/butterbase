import { describe, it, expect } from 'vitest';
import { AdminAuditLogsClient } from './audit-logs-client';
import type { AuditLog, AuditLogPage, AuditLogQueryOptions } from './types';

describe('AdminAuditLogsClient.query', () => {
  it('forwards all 10 filters in snake_case', async () => {
    const calls: string[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string) => { calls.push(p); return Promise.resolve({ logs: [], total: 0, limit: 50, offset: 0 }); },
    };
    const opts: AuditLogQueryOptions = {
      category: 'auth', eventType: 'login', action: 'create',
      resourceType: 'user', resourceId: 'u1', actorId: 'u2',
      from: '2026-01-01', to: '2026-02-01', limit: 50, offset: 0,
    };
    await new AdminAuditLogsClient(fc).query(opts);
    const url = new URL('http://x' + calls[0]);
    expect(url.searchParams.get('category')).toBe('auth');
    expect(url.searchParams.get('event_type')).toBe('login');
    expect(url.searchParams.get('action')).toBe('create');
    expect(url.searchParams.get('resource_type')).toBe('user');
    expect(url.searchParams.get('resource_id')).toBe('u1');
    expect(url.searchParams.get('actor_id')).toBe('u2');
    expect(url.searchParams.get('from')).toBe('2026-01-01');
    expect(url.searchParams.get('to')).toBe('2026-02-01');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('0');
  });

  it('omits undefined filters', async () => {
    const calls: string[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string) => { calls.push(p); return Promise.resolve({ logs: [], total: 0, limit: 50, offset: 0 }); },
    };
    await new AdminAuditLogsClient(fc).query({ limit: 10 });
    expect(calls[0]).toBe('/v1/app_x/audit-logs?limit=10');
  });

  it('no-args query hits bare path', async () => {
    const calls: string[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string) => { calls.push(p); return Promise.resolve({ logs: [], total: 0, limit: 50, offset: 0 }); },
    };
    await new AdminAuditLogsClient(fc).query();
    expect(calls[0]).toBe('/v1/app_x/audit-logs');
  });
});

describe('AuditLog type', () => {
  it('models all backend fields including legacy', () => {
    const l: AuditLog = {
      id: 'a', app_id: 'app_x', category: 'auth', event_type: 'login', action: 'create',
      resource_type: 'user', resource_id: 'u1', actor_type: 'user', actor_id: 'u2',
      event_data: { ip: '1.2.3.4' }, ip_address: '1.2.3.4', user_agent: 'curl',
      success: true, error_message: null, correlation_id: 'c1', created_at: '2026-01-01',
    };
    expect(l.correlation_id).toBe('c1');
  });

  it('AuditLogPage carries pagination metadata', () => {
    const p: AuditLogPage = { logs: [], total: 0, limit: 50, offset: 0, nextOffset: null };
    expect(p.nextOffset).toBeNull();
  });
});
