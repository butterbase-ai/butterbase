import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { apiGet, apiPost, apiPut, apiDelete, type ApiError } from '../lib/api-client.js';

// Shared helpers

function fail(msg: string): never {
  console.error(chalk.red(`✗ ${msg}`));
  process.exit(1);
}

function handleAuthError(err: unknown): never {
  const e = err as ApiError & { status?: number };
  if (e?.status === 401) fail('your key is invalid or expired — run `butterbase login`');
  if (e?.status === 403 && /scope/i.test(e?.error ?? '')) {
    fail('your active key is app-scoped — run `butterbase keys generate --substrate` and re-export BUTTERBASE_API_KEY');
  }
  fail(e?.error ?? String(err));
}

function readJsonFile(p: string): unknown {
  if (!p.startsWith('@')) fail(`expected @path, got '${p}'`);
  const path = p.slice(1);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { fail(`could not read ${path}: ${(e as Error).message}`); }
}

function print(json: boolean, value: unknown) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  console.log(JSON.stringify(value, null, 2));
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean' && v === false) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// Read commands (Task 9)
export async function substrateLedgerCommand(opts: { status?: string; capability?: string; limit?: string; before?: string; json?: boolean; }) {
  try {
    const q = qs({ status: opts.status, capability: opts.capability, limit: opts.limit, before: opts.before });
    const res = await apiGet<{ actions: any[] }>(`/v1/me/substrate/actions${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const a of res.actions ?? []) {
      console.log(`${a.id.padEnd(34)} ${a.status.padEnd(10)} ${a.action_type.padEnd(22)} ${a.proposed_at}`);
    }
  } catch (e) { handleAuthError(e); }
}

export async function substrateEntitiesListCommand(opts: { type?: string; limit?: string; json?: boolean }) {
  try {
    const q = qs({ type: opts.type, limit: opts.limit });
    const res = await apiGet<{ entities: any[]; total?: number }>(`/v1/me/substrate/entities${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const e of res.entities ?? []) console.log(`${e.id.padEnd(28)} ${e.type.padEnd(12)} ${e.display_name}`);
  } catch (e) { handleAuthError(e); }
}

export async function substrateEntitiesGetCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiGet<unknown>(`/v1/me/substrate/entities/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateArtifactsListCommand(opts: { kind?: string; q?: string; limit?: string; json?: boolean }) {
  try {
    const q = qs({ kind: opts.kind, q: opts.q, limit: opts.limit });
    const res = await apiGet<{ source_artifacts: any[]; total?: number }>(`/v1/me/substrate/source-artifacts${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const a of res.source_artifacts ?? []) {
      console.log(`${a.id.padEnd(28)} ${a.kind.padEnd(16)} ${a.title}`);
    }
  } catch (e) { handleAuthError(e); }
}

export async function substrateArtifactsGetCommand(id: string, _opts: { json?: boolean }) {
  try {
    const res = await apiGet<unknown>(`/v1/me/substrate/source-artifacts/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateMemoryCommand(query: string, opts: { limit?: string; json?: boolean }) {
  try {
    const q = qs({ q: query, limit: opts.limit });
    const res = await apiGet<{ results: any[] }>(`/v1/me/substrate/memory${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const r of res.results ?? []) {
      console.log(`${r.kind?.padEnd(12)} ${r.id?.padEnd(24)} ${r.snippet ?? r.title ?? ''}`);
    }
  } catch (e) { handleAuthError(e); }
}

export async function substrateOutboxListCommand(opts: { state?: string; json?: boolean }) {
  try {
    const q = qs({ state: opts.state });
    const res = await apiGet<{ outbox: any[] }>(`/v1/me/substrate/outbox${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const o of res.outbox ?? []) console.log(`${o.id.padEnd(26)} ${o.state.padEnd(10)} ${o.target.padEnd(24)} attempts=${o.attempts}`);
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesListCommand(opts: { enabled?: boolean; json?: boolean }) {
  try {
    const q = qs({ enabled: opts.enabled });
    const res = await apiGet<{ rules: any[] }>(`/v1/me/substrate/attention-rules${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const r of res.rules ?? []) console.log(`${r.id.padEnd(30)} ${r.enabled ? 'on ' : 'off'} ${r.trigger_cron.padEnd(18)} ${r.name}`);
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesGetCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiGet<unknown>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesFiringsCommand(id: string, opts: { limit?: string; json?: boolean }) {
  try {
    const q = qs({ limit: opts.limit });
    const res = await apiGet<{ firings: any[] }>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}/firings${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const f of res.firings ?? []) console.log(`${f.id.padEnd(26)} ${f.status.padEnd(16)} bindings=${f.binding_count} ${f.fired_at}`);
  } catch (e) { handleAuthError(e); }
}

export async function substrateSnapshotsCommand(opts: { days?: string; json?: boolean }) {
  try {
    const q = qs({ days: opts.days });
    const res = await apiGet<{ snapshots: any[] }>(`/v1/me/substrate/snapshots${q}`);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    for (const s of res.snapshots ?? []) console.log(`${s.snapshot_date}  entities=${s.entity_count}  decisions24h=${s.decision_count_24h}`);
  } catch (e) { handleAuthError(e); }
}

export async function substrateSettingsShowCommand(opts: { json?: boolean }) {
  try {
    const res = await apiGet<{ yolo_mode: boolean }>(`/v1/me/substrate/settings`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateLedgerInspectCommand(actionId: string, _opts: { json?: boolean }) {
  try {
    const res = await apiGet<unknown>(`/v1/me/substrate/actions/${encodeURIComponent(actionId)}`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateProposeCommand(
  capability: string,
  opts: { payload?: string; idempotencyKey?: string; json?: boolean },
) {
  if (!opts.payload) fail('missing --payload @path/to/file.json');
  const payload = readJsonFile(opts.payload);
  const body: Record<string, unknown> = { capability, payload };
  if (opts.idempotencyKey) body.idempotency_key = opts.idempotencyKey;
  try {
    const res = await apiPost<unknown>('/v1/me/substrate/actions/propose', body);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateApproveCommand(actionId: string, opts: { json?: boolean }) {
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/actions/${encodeURIComponent(actionId)}/approve`, {});
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRejectCommand(actionId: string, opts: { reason?: string; json?: boolean }) {
  const body: Record<string, unknown> = {};
  if (opts.reason) body.reason = opts.reason;
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/actions/${encodeURIComponent(actionId)}/reject`, body);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateEntitiesUpdateCommand(id: string, opts: { patch?: string; json?: boolean }) {
  if (!opts.patch) fail('missing --patch @path/to/file.json');
  const patch = readJsonFile(opts.patch) as Record<string, unknown>;
  // Entity mutations flow through the substrate action ledger for auditability —
  // there is no direct PUT route. We propose an `update_entity` capability action.
  const body = { capability: 'update_entity', payload: { id, ...patch } };
  try {
    const res = await apiPost<unknown>('/v1/me/substrate/actions/propose', body);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateOutboxCancelCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/outbox/${encodeURIComponent(id)}/cancel`, {});
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateOutboxRetryCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/outbox/${encodeURIComponent(id)}/retry`, {});
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesCreateCommand(opts: { file?: string; json?: boolean }) {
  if (!opts.file) fail('missing --file @path/to/rule.json');
  const body = readJsonFile(opts.file) as Record<string, unknown>;
  try {
    const res = await apiPost<unknown>('/v1/me/substrate/attention-rules', body);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesUpdateCommand(id: string, opts: { file?: string; json?: boolean }) {
  if (!opts.file) fail('missing --file @path/to/rule.json');
  const body = readJsonFile(opts.file) as Record<string, unknown>;
  try {
    const res = await apiPut<unknown>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesDeleteCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiDelete<unknown>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesEnableCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}/enable`, {});
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateRulesDisableCommand(id: string, opts: { json?: boolean }) {
  try {
    const res = await apiPost<unknown>(`/v1/me/substrate/attention-rules/${encodeURIComponent(id)}/disable`, {});
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

export async function substrateSettingsYoloCommand(state: string, opts: { json?: boolean }) {
  const normalized = state.toLowerCase();
  if (normalized !== 'on' && normalized !== 'off') fail(`expected 'on' or 'off', got '${state}'`);
  try {
    const res = await apiPut<unknown>(`/v1/me/substrate/settings/yolo`, { yolo_mode: normalized === 'on' });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { handleAuthError(e); }
}

// Re-export helpers so Tasks 9/10 can use them.
export const _internal = { fail, handleAuthError, readJsonFile, print, apiGet, apiPost, apiPut, apiDelete };
