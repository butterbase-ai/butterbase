import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerOfficeCommands } from '../commands/office.js';
import { openOfficeConfirmation } from '../lib/office-client.js';
const config = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', () => ({ getMergedConfig: config, DEFAULT_ENDPOINT: 'https://api.example', getCurrentAppId: () => { throw new Error('Office must not select an app'); } }));
vi.mock('../lib/office-client.js', async original => ({ ...(await original<typeof import('../lib/office-client.js')>()), openOfficeConfirmation: vi.fn() }));
const org = 'de471e72-82e4-41ce-bac4-20bd6755b108';
const id = 'b9bb028e-e99c-4c9b-aa74-d4d96b462391';
const pending = { state: 'awaiting_confirmation', confirmation_id: id, expires_at: '2099-01-01T00:00:00.000Z', confirmation_url: `https://dashboard.example/office/confirm/${id}` };
let directory: string;
let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
let fetch: ReturnType<typeof vi.spyOn>;
function program() { const root = new Command('butterbase'); root.configureOutput({ writeErr: text => console.error(text), writeOut: text => console.log(text) }); registerOfficeCommands(root); return root; }
async function run(args: string[]) { await program().parseAsync(['office', ...args], { from: 'user' }); }
function output() { expect(logs).toHaveBeenCalledTimes(1); return JSON.parse(String(logs.mock.calls[0][0])); }
beforeEach(() => {
  process.exitCode = undefined; vi.stubEnv('BUTTERBASE_API_KEY', ''); vi.stubEnv('BUTTERBASE_CONTROL_API_URL', 'https://api.example');
  config.mockResolvedValue({ endpoint: 'https://api.example', apiKey: 'platform-key' });
  logs = vi.spyOn(console, 'log').mockImplementation(() => {}); errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    return new Response(JSON.stringify(path.includes('/confirmations') ? pending : path.endsWith('/ask')
      ? { state: 'running', conversation_id: id, turn_id: id, output: 'Partial' } : path === '/v1/me/office'
        ? { status: { organization_id: org, activation_state: 'enabled', can_enable: false, can_approve: true, work_allowed: true, paused: false, blocked_reason: null, last_turn: null } }
        : { items: [], next_cursor: 'next-page' }));
  });
  vi.mocked(openOfficeConfirmation).mockResolvedValue(); directory = mkdtempSync(join(tmpdir(), 'butterbase-office-cli-'));
});
afterEach(() => { process.exitCode = undefined; if (directory.startsWith(join(tmpdir(), 'butterbase-office-cli-'))) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('office command surface', () => {
  it('records agent memory through its explicit category and preserves the write key', async () => {
    const payload = { title: 'Reports', relevance_summary: 'For reporting', body: 'Short summary first', capture_origin: 'owner_request' };
    const file = join(directory, 'agent-memory.json'); writeFileSync(file, JSON.stringify(payload));
    await run(['agent-memories', 'record', '--file', file, '--org', org, '--json', '--idempotency-key', 'remember-report']);
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(String(url)).toContain('/office/agent-memories/record');
    expect(JSON.parse(init!.body as string)).toEqual({ payload: { ...payload, sources: [] }, idempotency_key: 'remember-report' });
  });
  it('registers the business and agent memory commands and exposes org/json on help', () => {
    const root = program(); const leaves = (command: Command, prefix = ''): string[] => command.commands.length
      ? command.commands.flatMap(child => leaves(child, `${prefix}${child.name()} `)) : [prefix.trim()];
    expect(leaves(root).sort()).toEqual([
      'office status', 'office enable', 'office pause', 'office resume', 'office ask',
      'office decisions list', 'office decisions get', 'office decisions context', 'office decisions approve', 'office decisions deny',
      'office conversations create', 'office conversations list', 'office conversations get',
      'office memory list', 'office memory search', 'office memory source get', 'office memory record-decision',
      'office memory record-commitment', 'office memory record-learning', 'office principles list', 'office principles get', 'office principles record',
      'office agent-memories list', 'office agent-memories search', 'office agent-memories get',
      'office agent-memories record', 'office agent-memories amend', 'office agent-memories archive',
    ].sort());
    const office = root.commands[0]; expect(office.helpInformation()).toContain('--org <uuid>'); expect(office.helpInformation()).toContain('--json');
    expect(office.commands.find(command => command.name() === 'enable')!.helpInformation()).toContain('--open');
  });
  it.each([['status'], ['enable'], ['decisions', 'list'], ['conversations', 'list'], ['memory', 'list'], ['principles', 'list']])('requires an explicit org for %j with usage exit 2 and one JSON error', async (...args) => {
    await expect(run([...args, '--json'])).rejects.toMatchObject({ exitCode: 2 });
    expect(output()).toMatchObject({ error: { code: 'invalid_request' } }); expect(fetch).not.toHaveBeenCalled();
  });
  it('maps read commands, preserves pagination, and does not select an app', async () => {
    await run(['memory', 'list', '--org', org, '--limit', '3', '--cursor', 'cursor-in', '--json']);
    expect(String(fetch.mock.calls[0][0])).toContain('/memory?cursor=cursor-in&limit=3');
    expect(output().data.next_cursor).toBe('next-page'); expect(process.exitCode ?? 0).toBe(0);
  });
  it('returns a pending protected receipt without launching a browser unless --open is explicit', async () => {
    await run(['enable', '--org', org, '--json']); expect(output()).toEqual({ data: pending, error: null });
    expect(openOfficeConfirmation).not.toHaveBeenCalled(); expect(process.exitCode ?? 0).toBe(0);
  });
  it('keeps the URL/receipt when opt-in browser opening fails, with diagnostics only on stderr', async () => {
    vi.mocked(openOfficeConfirmation).mockRejectedValue(new Error('headless'));
    await run(['enable', '--org', org, '--open', '--json']); expect(output().data).toEqual(pending);
    expect(openOfficeConfirmation).toHaveBeenCalledWith(pending.confirmation_url);
    expect(errors.mock.calls.flat().join(' ')).toContain(pending.confirmation_url); expect(process.exitCode ?? 0).toBe(0);
  });
  it('maps source-aware approval and caller idempotency key', async () => {
    await run(['decisions', 'approve', id, '--source', 'substrate', '--idempotency-key', 'retry-key', '--org', org, '--json']);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ action: 'approve', decision: { source: 'substrate', id }, idempotency_key: 'retry-key' });
  });
  it('observes a receipt without any mutation', async () => {
    await run(['status', '--confirmation', id, '--org', org, '--json']); expect(output().data).toEqual(pending);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });
  it.each(['rejected', 'expired', 'outcome_unknown'])('wait returns exit 1 with the actual %s receipt', async state => {
    const terminal = { state, confirmation_id: id, ...(state === 'outcome_unknown' ? { error: { code: 'outcome_unknown', message: 'Check status.' } } : {}) };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(pending))).mockResolvedValueOnce(new Response(JSON.stringify(terminal)));
    await run(['pause', '--wait', '--org', org, '--json']); expect(output().data.state).toBe(state); expect(process.exitCode).toBe(1);
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'GET']);
  });
  it('wait timeout retains its receipt and never says the operation did not execute', async () => {
    vi.useFakeTimers(); const result = run(['resume', '--wait', '--wait-timeout', '30', '--org', org, '--json']);
    await vi.advanceTimersByTimeAsync(40); await result;
    expect(output()).toMatchObject({ data: pending, error: { code: 'observation_timeout' } }); expect(process.exitCode).toBe(1);
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1); vi.useRealTimers();
  });
  it('gives actionable authentication guidance and typed JSON failures', async () => {
    config.mockResolvedValue({ endpoint: 'https://api.example' });
    await run(['status', '--org', org, '--json']); expect(output().error).toMatchObject({ code: 'unauthenticated' });
    expect(errors.mock.calls.flat().join(' ')).toContain('butterbase login'); expect(fetch).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  });
  it.each(['not-json', '{"title":"missing-description"}'])('rejects malformed/native-invalid files with usage exit 2', async contents => {
    const file = join(directory, 'input.json'); writeFileSync(file, contents);
    await run(['memory', 'record-learning', '--file', file, '--org', org, '--json']);
    expect(output().error.code).toBe('invalid_request'); expect(process.exitCode).toBe(2); expect(fetch).not.toHaveBeenCalled();
  });
  it('validates a full native payload and uses the wrapper route', async () => {
    const file = join(directory, 'input.json'); writeFileSync(file, JSON.stringify({ title: 'Lesson', description: 'Context' }));
    await run(['memory', 'record-learning', '--file', file, '--org', org, '--json']);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/memory\/record_learning$/);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).payload).toEqual({ title: 'Lesson', description: 'Context' }); output();
  });
  it('shares Ask admission and emits one JSON object containing public stream events', async () => {
    const events = [{ sequence: 1, type: 'started', turn_id: id, conversation_id: id }, { sequence: 2, type: 'text_delta', text: 'Answer' }, { sequence: 3, type: 'completed', turn_id: id, conversation_id: id }];
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'running', conversation_id: id, turn_id: id, output: '' })))
      .mockResolvedValueOnce(new Response(events.map(event => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    await run(['ask', 'Question', '--stream', '--org', org, '--json']); expect(output().data.events).toEqual(events);
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it.each([false, true])('prints streamed text once when a final replacement snapshot follows (chunked=%s)', async chunked => {
    const events = [
      { sequence: 1, type: 'started', turn_id: id, conversation_id: id },
      { sequence: 2, type: 'text_delta', text: 'Thinking. ' },
      { sequence: 3, type: 'text_delta', text: 'The answer.' },
      { sequence: 4, type: 'message', text: chunked ? 'The ' : 'The answer.' },
      ...(chunked ? [{ sequence: 5, type: 'text_delta', text: 'answer.' }] : []),
      { sequence: chunked ? 6 : 5, type: 'completed', turn_id: id, conversation_id: id },
    ];
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'running', conversation_id: id, turn_id: id, output: '' })))
      .mockResolvedValueOnce(new Response(events.map(event => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await run(['ask', 'Question', '--stream', '--org', org]);
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toBe('Thinking. The answer.\n');
    expect(process.exitCode).toBe(0);
  });
  it('SIGINT ends observation with exact turn pointers and no resubmission', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'running', conversation_id: id, turn_id: id, output: '' })))
      .mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = run(['ask', 'Question', '--stream', '--org', org, '--json']);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); process.emit('SIGINT'); await result;
    expect(output()).toMatchObject({ error: { code: 'aborted', turn_id: id, conversation_id: id } });
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1); expect(process.exitCode).toBe(1);
  });
  it('reports a streamed business failure with its actual reason and exit 1', async () => {
    const events = [{ sequence: 1, type: 'started', turn_id: id, conversation_id: id },
      { sequence: 2, type: 'blocked', error: { code: 'credits_required', message: 'Add credits before continuing.' } }];
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'running', conversation_id: id, turn_id: id, output: '' })))
      .mockResolvedValueOnce(new Response(events.map(event => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    await run(['ask', 'Question', '--stream', '--org', org, '--json']);
    expect(output()).toMatchObject({ data: { state: 'blocked' }, error: { code: 'credits_required' } }); expect(process.exitCode).toBe(1);
  });
});
