import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api-client.js', () => ({
  apiGet:    vi.fn(),
  apiPost:   vi.fn(),
  apiPut:    vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api-client.js';
import {
  substrateLedgerCommand,
  substrateEntitiesListCommand,
  substrateEntitiesGetCommand,
  substrateMemoryCommand,
  substrateOutboxListCommand,
  substrateRulesListCommand,
  substrateRulesGetCommand,
  substrateRulesFiringsCommand,
  substrateSnapshotsCommand,
  substrateSettingsShowCommand,
} from '../commands/substrate.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('read commands', () => {
  it('ledger sends GET /v1/me/substrate/actions with filters', async () => {
    (apiGet as any).mockResolvedValue({ actions: [] });
    await substrateLedgerCommand({ status: 'executed', capability: 'send_email_draft', limit: '50', json: true });
    expect(apiGet).toHaveBeenCalledWith('/v1/me/substrate/actions?status=executed&capability=send_email_draft&limit=50');
  });

  it('ledger includes --before in query string when provided', async () => {
    (apiGet as any).mockResolvedValue({ actions: [] });
    await substrateLedgerCommand({ before: '2026-05-28T00:00:00Z', json: true });
    expect((apiGet as any).mock.calls[0][0]).toContain('before=');
  });

  it('entities list sends GET /entities with type filter', async () => {
    (apiGet as any).mockResolvedValue({ entities: [] });
    await substrateEntitiesListCommand({ type: 'person', limit: '10', json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/entities?type=person&limit=10');
  });

  it('entities get fetches a single entity', async () => {
    (apiGet as any).mockResolvedValue({ id: 'ent_1' });
    await substrateEntitiesGetCommand('ent_1', { json: true });
    expect(apiGet).toHaveBeenCalledWith('/v1/me/substrate/entities/ent_1');
  });

  it('memory sends GET /memory with query', async () => {
    (apiGet as any).mockResolvedValue({ results: [] });
    await substrateMemoryCommand('how to win', { limit: '5', json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/memory?q=how+to+win&limit=5');
  });

  it('outbox list with state', async () => {
    (apiGet as any).mockResolvedValue({ outbox: [] });
    await substrateOutboxListCommand({ state: 'pending', json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/outbox?state=pending');
  });

  it('rules list', async () => {
    (apiGet as any).mockResolvedValue({ rules: [] });
    await substrateRulesListCommand({ enabled: true, json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/attention-rules?enabled=true');
  });

  it('rules get', async () => {
    (apiGet as any).mockResolvedValue({ id: 'rule_1' });
    await substrateRulesGetCommand('rule_1', { json: true });
    expect(apiGet).toHaveBeenCalledWith('/v1/me/substrate/attention-rules/rule_1');
  });

  it('rules firings', async () => {
    (apiGet as any).mockResolvedValue({ firings: [] });
    await substrateRulesFiringsCommand('rule_1', { limit: '20', json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/attention-rules/rule_1/firings?limit=20');
  });

  it('snapshots', async () => {
    (apiGet as any).mockResolvedValue({ snapshots: [] });
    await substrateSnapshotsCommand({ days: '7', json: true });
    expect((apiGet as any).mock.calls[0][0]).toBe('/v1/me/substrate/snapshots?days=7');
  });

  it('settings show', async () => {
    (apiGet as any).mockResolvedValue({ yolo_mode: false });
    await substrateSettingsShowCommand({ json: true });
    expect(apiGet).toHaveBeenCalledWith('/v1/me/substrate/settings');
  });

  it('surfaces auth-scope hint on 403 scope mismatch', async () => {
    (apiGet as any).mockRejectedValue({ status: 403, error: 'token is not substrate-scoped' });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => { throw new Error('exit'); }) as any);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(substrateLedgerCommand({ json: true })).rejects.toThrow('exit');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/app-scoped/);
    exit.mockRestore(); errSpy.mockRestore();
  });
});
