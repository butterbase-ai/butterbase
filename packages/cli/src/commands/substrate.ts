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

// Commands (stubs - implemented in Tasks 9 + 10)
export async function substrateLedgerCommand(_opts: { status?: string; capability?: string; limit?: string; before?: string; json?: boolean; }) { fail('not yet implemented (Task 9)'); }
export async function substrateLedgerInspectCommand(_actionId: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateProposeCommand(_capability: string, _opts: { payload?: string; idempotencyKey?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateApproveCommand(_actionId: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRejectCommand(_actionId: string, _opts: { reason?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateEntitiesListCommand(_opts: { type?: string; limit?: string; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateEntitiesGetCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateEntitiesUpdateCommand(_id: string, _opts: { patch?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateMemoryCommand(_query: string, _opts: { limit?: string; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateOutboxListCommand(_opts: { state?: string; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateOutboxCancelCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateOutboxRetryCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesListCommand(_opts: { enabled?: boolean; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateRulesGetCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateRulesCreateCommand(_opts: { file?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesUpdateCommand(_id: string, _opts: { file?: string; json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesDeleteCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesEnableCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesDisableCommand(_id: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }
export async function substrateRulesFiringsCommand(_id: string, _opts: { limit?: string; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateSnapshotsCommand(_opts: { days?: string; json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateSettingsShowCommand(_opts: { json?: boolean }) { fail('not yet implemented (Task 9)'); }
export async function substrateSettingsYoloCommand(_state: string, _opts: { json?: boolean }) { fail('not yet implemented (Task 10)'); }

// Re-export helpers so Tasks 9/10 can use them.
export const _internal = { fail, handleAuthError, readJsonFile, print, apiGet, apiPost, apiPut, apiDelete };
