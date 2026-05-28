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
    fail('your active key is app-scoped — run `butterbase keys generate --scope substrate` and re-export BUTTERBASE_API_KEY');
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

// Stubs - implemented in Task 9 (inspect) and Task 10 (write commands)
export async function substrateLedgerInspectCommand(_actionId: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateProposeCommand(_capability: string, _opts: { payload?: string; idempotencyKey?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateApproveCommand(_actionId: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRejectCommand(_actionId: string, _opts: { reason?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateEntitiesUpdateCommand(_id: string, _opts: { patch?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateOutboxCancelCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateOutboxRetryCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesCreateCommand(_opts: { file?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesUpdateCommand(_id: string, _opts: { file?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesDeleteCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesEnableCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesDisableCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateSettingsYoloCommand(_state: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }

// Re-export helpers so Tasks 9/10 can use them.
export const _internal = { fail, handleAuthError, readJsonFile, print, apiGet, apiPost, apiPut, apiDelete };
