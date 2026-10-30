import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeClient, OfficeClientError } from '../index.js';
const org = 'de471e72-82e4-41ce-bac4-20bd6755b108';
const id = 'b9bb028e-e99c-4c9b-aa74-d4d96b462391';
const pending = { state: 'awaiting_confirmation', confirmation_id: id, confirmation_url: `https://dashboard.example/office/confirm/${id}`, expires_at: '2099-01-01T00:00:00.000Z' };
const turn = { state: 'running', conversation_id: id, turn_id: id, output: '' };
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const data = path.endsWith('/ask') ? turn : path.includes('/confirmations') ? pending
      : path === '/v1/me/office' ? { organization_id: org, activation_state: 'enabled', can_enable: false, can_approve: true,
        work_allowed: true, paused: false, blocked_reason: null, last_turn: null } : { items: [], next_cursor: null };
    return new Response(JSON.stringify(data));
  });
  const getToken = vi.fn(() => 'platform-token');
  const client = new OfficeClient({ apiUrl: 'https://api.example/', organizationId: org, getToken, fetch });
  return { client, fetch, getToken };
}
afterEach(() => vi.useRealTimers());
describe('standalone OfficeClient public export', () => {
  it('maps all 22 methods with explicit organization and a fresh token for every request; no app required', async () => {
    const { client, fetch, getToken } = setup();
    const ref = { source: 'substrate' as const, id };
    const calls: Array<[() => Promise<unknown>, string, string]> = [
      [() => client.getStatus(), 'GET', '/office'],
      [() => client.enable(), 'POST', '/confirmations'], [() => client.pause(), 'POST', '/confirmations'], [() => client.resume(), 'POST', '/confirmations'],
      [() => client.decisions.list({ status: 'all', limit: 5 }), 'GET', '/decisions?limit=5&status=all'],
      [() => client.decisions.get(ref), 'GET', `/decisions/substrate/${id}`],
      [() => client.decisions.getContext(ref, { limit: 7 }), 'GET', `/decisions/substrate/${id}/context?limit=7`],
      [() => client.decisions.approve(ref), 'POST', '/confirmations'],
      [() => client.decisions.deny(ref, { reason: 'No' }), 'POST', `/decisions/substrate/${id}/deny`],
      [() => client.conversations.create({ title: 'Example' }), 'POST', '/conversations'],
      [() => client.conversations.list({ limit: 2 }), 'GET', '/conversations?limit=2'],
      [() => client.conversations.get(id, { turnId: id, afterSequence: 4 }), 'GET', `/conversations/${id}?turn_id=${id}&after_sequence=4`],
      [() => client.ask('Question', { conversationId: id }), 'POST', '/ask'],
      [() => client.memory.list({ kind: 'learning' }), 'GET', '/memory?kind=learning'],
      [() => client.memory.search('Example & team', { limit: 3 }), 'GET', '/memory/search?query=Example+%26+team&limit=3'],
      [() => client.memory.getSourceArtifact(id), 'GET', `/memory/sources/${id}`],
      [() => client.memory.recordDecision({ title: 'Direction', kind: 'operational' }), 'POST', '/memory/record_decision'],
      [() => client.memory.recordCommitment({ description: 'Deliver', status: 'proposed' }), 'POST', '/memory/record_commitment'],
      [() => client.memory.recordLearning({ title: 'Lesson', description: 'Context' }), 'POST', '/memory/record_learning'],
      [() => client.principles.list(), 'GET', '/principles'], [() => client.principles.get(id), 'GET', `/principles/${id}`],
      [() => client.principles.record({ title: 'Principle', applies_to: {}, constraint_spec: {} }), 'POST', '/memory/record_principle'],
    ];
    for (const [invoke, method, suffix] of calls) {
      await invoke(); const [url, init] = fetch.mock.calls.at(-1)!;
      expect(String(url)).toContain(suffix); expect(init?.method).toBe(method);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer platform-token', 'x-organization-id': org });
    }
    expect(fetch).toHaveBeenCalledTimes(22); expect(getToken).toHaveBeenCalledTimes(22);
  });
  it('keeps pending confirmation receipts distinct from successful execution', async () => {
    const { client } = setup(); expect(await client.enable()).toEqual({ data: pending, error: null });
    expect(await client.getConfirmation(id)).toEqual({ data: pending, error: null });
  });
  it('unwraps the existing REST status envelope without changing the public OfficeStatus type', async () => {
    const { client, fetch } = setup();
    const status = { organization_id: org, activation_state: 'enabled', can_enable: false, can_approve: true,
      work_allowed: true, paused: false, blocked_reason: null, last_turn: null };
    fetch.mockResolvedValue(new Response(JSON.stringify({ status })));
    expect(await client.getStatus()).toEqual({ data: status, error: null });
  });
  it('reuses one generated key across a network retry, but a second deliberate Ask gets a new key', async () => {
    const { client, fetch, getToken } = setup(); fetch.mockRejectedValueOnce(new TypeError('disconnected'));
    expect((await client.ask('Question')).error).toBeNull(); await client.ask('Question');
    const keys = fetch.mock.calls.map(c => JSON.parse(c[1]?.body as string).idempotency_key);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]); expect(getToken).toHaveBeenCalledTimes(3);
    await client.ask('Question', { idempotencyKey: 'caller-key' });
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]?.body as string).idempotency_key).toBe('caller-key');
  });
  it('returns typed HTTP failures and never retries revoked credentials', async () => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'credential_revoked', message: 'Repair the key.' } }), { status: 403 }));
    const result = await client.getStatus(); expect(result.data).toBeNull(); expect(result.error).toBeInstanceOf(OfficeClientError);
    expect(result.error).toMatchObject({ code: 'credential_revoked', status: 403 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('validates native payloads before sending and never leaks raw token-provider errors', async () => {
    const { client, fetch, getToken } = setup();
    expect((await client.memory.recordLearning({ title: 'missing' } as never)).error).toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
    getToken.mockImplementation(() => { throw new Error('secret-provider-diagnostic'); });
    const result = await client.getStatus(); expect(result.error).toMatchObject({ code: 'unauthenticated' });
    expect(result.error?.message).not.toContain('secret-provider');
  });
  it('waits with only GETs and returns the real terminal/unknown receipt', async () => {
    vi.useFakeTimers(); const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(pending))).mockResolvedValueOnce(new Response(JSON.stringify({ state: 'outcome_unknown', confirmation_id: id, error: { code: 'outcome_unknown', message: 'Inspect first.' } })));
    const result = client.waitForConfirmation(id, { timeoutMs: 5000, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).data?.state).toBe('outcome_unknown');
    expect(fetch.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it('bounds observation and retains the last receipt without rejecting or cancelling the operation', async () => {
    vi.useFakeTimers(); const { client, fetch } = setup();
    const waiting = client.waitForConfirmation(id, { timeoutMs: 30, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(35);
    const result = await waiting; expect(result.error).toMatchObject({ code: 'observation_timeout' }); expect(result.data).toEqual(pending);
    expect(fetch.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it('aborts an in-flight wait at its deadline even when the server never responds', async () => {
    vi.useFakeTimers(); const { client, fetch } = setup();
    fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const waiting = client.waitForConfirmation(id, { timeoutMs: 25 }); await vi.advanceTimersByTimeAsync(30);
    expect((await waiting).error).toMatchObject({ code: 'observation_timeout' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds observation even when asynchronous token refresh does not settle', async () => {
    vi.useFakeTimers(); const { client, getToken } = setup();
    getToken.mockImplementation(() => new Promise(() => {}) as never);
    let code: string | undefined;
    void client.waitForConfirmation(id, { timeoutMs: 25 }).then(result => { code = result.error?.code; });
    await vi.advanceTimersByTimeAsync(30); expect(code).toBe('observation_timeout');
  });
  it('returns the generated request key when both network attempts fail, so callers can retry safely', async () => {
    const { client, fetch } = setup(); fetch.mockRejectedValue(new TypeError('socket closed'));
    const result = await client.ask('Question');
    const key = JSON.parse(fetch.mock.calls[0][1]?.body as string).idempotency_key;
    expect(result.error).toMatchObject({ code: 'connection_error', idempotencyKey: key });
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string).idempotency_key).toBe(key);
  });
  it('reports a response-body disconnection as a connection failure instead of malformed JSON', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('socket closed')); } })));
    expect((await client.ask('Question')).error).toMatchObject({ code: 'connection_error' });
  });
});
