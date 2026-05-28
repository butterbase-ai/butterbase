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

import {
  substrateProposeCommand,
  substrateApproveCommand,
  substrateRejectCommand,
  substrateEntitiesUpdateCommand,
  substrateOutboxCancelCommand,
  substrateOutboxRetryCommand,
  substrateRulesCreateCommand,
  substrateRulesUpdateCommand,
  substrateRulesDeleteCommand,
  substrateRulesEnableCommand,
  substrateRulesDisableCommand,
  substrateSettingsYoloCommand,
} from '../commands/substrate.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpJson(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-cli-'));
  const p = join(dir, 'payload.json');
  writeFileSync(p, JSON.stringify(obj));
  return `@${p}`;
}

describe('write commands', () => {
  it('propose sends POST /actions/propose with body from --payload @file', async () => {
    (apiPost as any).mockResolvedValue({ id: 'act_1', status: 'proposed' });
    const payload = tmpJson({ to: 'a@b.c', subject: 'x', body: 'y' });
    await substrateProposeCommand('send_email_draft', { payload, idempotencyKey: 'k1', json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/actions/propose', {
      capability: 'send_email_draft',
      payload: { to: 'a@b.c', subject: 'x', body: 'y' },
      idempotency_key: 'k1',
    });
  });

  it('approve sends POST /actions/:id/approve', async () => {
    (apiPost as any).mockResolvedValue({ id: 'act_1', status: 'executed' });
    await substrateApproveCommand('act_1', { json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/actions/act_1/approve', {});
  });

  it('reject sends POST /actions/:id/reject with reason', async () => {
    (apiPost as any).mockResolvedValue({ id: 'act_1', status: 'rejected' });
    await substrateRejectCommand('act_1', { reason: 'no', json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/actions/act_1/reject', { reason: 'no' });
  });

  it('entities update sends PUT /entities/:id with patch body', async () => {
    (apiPut as any).mockResolvedValue({ id: 'ent_1' });
    const patch = tmpJson({ display_name: 'New name' });
    await substrateEntitiesUpdateCommand('ent_1', { patch, json: true });
    expect(apiPut).toHaveBeenCalledWith('/v1/me/substrate/entities/ent_1', { display_name: 'New name' });
  });

  it('outbox cancel sends POST /outbox/:id/cancel', async () => {
    (apiPost as any).mockResolvedValue({ id: 'ob_1', state: 'cancelled' });
    await substrateOutboxCancelCommand('ob_1', { json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/outbox/ob_1/cancel', {});
  });

  it('outbox retry sends POST /outbox/:id/retry', async () => {
    (apiPost as any).mockResolvedValue({ id: 'ob_1', state: 'queued' });
    await substrateOutboxRetryCommand('ob_1', { json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/outbox/ob_1/retry', {});
  });

  it('rules create POSTs the file body', async () => {
    (apiPost as any).mockResolvedValue({ id: 'rule_1' });
    const file = tmpJson({ name: 'r', trigger_cron: '0 9 * * *' });
    await substrateRulesCreateCommand({ file, json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/attention-rules', { name: 'r', trigger_cron: '0 9 * * *' });
  });

  it('rules update PUTs the file body', async () => {
    (apiPut as any).mockResolvedValue({ id: 'rule_1' });
    const file = tmpJson({ enabled: false });
    await substrateRulesUpdateCommand('rule_1', { file, json: true });
    expect(apiPut).toHaveBeenCalledWith('/v1/me/substrate/attention-rules/rule_1', { enabled: false });
  });

  it('rules delete sends DELETE', async () => {
    (apiDelete as any).mockResolvedValue({ deleted: true });
    await substrateRulesDeleteCommand('rule_1', { json: true });
    expect(apiDelete).toHaveBeenCalledWith('/v1/me/substrate/attention-rules/rule_1');
  });

  it('rules enable sends POST /enable', async () => {
    (apiPost as any).mockResolvedValue({ id: 'rule_1', enabled: true });
    await substrateRulesEnableCommand('rule_1', { json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/attention-rules/rule_1/enable', {});
  });

  it('rules disable sends POST /disable', async () => {
    (apiPost as any).mockResolvedValue({ id: 'rule_1', enabled: false });
    await substrateRulesDisableCommand('rule_1', { json: true });
    expect(apiPost).toHaveBeenCalledWith('/v1/me/substrate/attention-rules/rule_1/disable', {});
  });

  it('settings yolo on sends PUT /settings/yolo', async () => {
    (apiPut as any).mockResolvedValue({ yolo_mode: true });
    await substrateSettingsYoloCommand('on', { json: true });
    expect(apiPut).toHaveBeenCalledWith('/v1/me/substrate/settings/yolo', { yolo_mode: true });
  });

  it('settings yolo off sends PUT /settings/yolo with false', async () => {
    (apiPut as any).mockResolvedValue({ yolo_mode: false });
    await substrateSettingsYoloCommand('off', { json: true });
    expect(apiPut).toHaveBeenCalledWith('/v1/me/substrate/settings/yolo', { yolo_mode: false });
  });
});
