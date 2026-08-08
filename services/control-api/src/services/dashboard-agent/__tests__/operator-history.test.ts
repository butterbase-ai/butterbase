/**
 * I2 — bounding what an operator turn replays to the gateway.
 *
 * Two halves:
 *   1. `trimOperatorHistory` as a pure function, where the PAIRING-INTEGRITY
 *      property is asserted directly and hard. That property is the whole
 *      reason this is not a "keep the last N messages" one-liner: a cut that
 *      lands between an assistant `tool_calls` row and its `role:'tool'`
 *      result produces the history the gateway rejects, and with one operator
 *      conversation per org that bricks the org's operator on every wake,
 *      forever.
 *   2. `runAgentTurn` end to end (mocked I/O), where what actually reaches the
 *      gateway is inspected — including the must-pass-both-ways pin that a
 *      NON-operator conversation replays byte-identically.
 *
 * Deliberately a SEPARATE file from loop.test.ts, which cannot be run in this
 * environment (pre-existing JS heap OOM, reproduced at branch base). loop.ts
 * has no other regression net, so the human-assistant pin below is load-bearing.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import type { Message } from '../store.js';
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';
import {
  trimOperatorHistory,
  replayCost,
  OPERATOR_HISTORY_MAX_CHARS,
  OPERATOR_HISTORY_MAX_MESSAGES,
} from '../operator-history.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const HUMAN_USER = 'cognito-sub-abc';
const stubPool = {} as pg.Pool;

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

let seq = 0;
function row(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  seq += 1;
  return {
    id: `m-${seq}`,
    conversationId: 'conv-1',
    role: partial.role,
    content: partial.content ?? '',
    toolCallId: partial.toolCallId ?? null,
    toolName: partial.toolName ?? null,
    toolArgs: partial.toolArgs ?? null,
    toolResult: partial.toolResult ?? null,
    modelUsed: partial.modelUsed ?? null,
    createdAt: new Date(1_700_000_000_000 + seq * 1000),
  } as Message;
}

const user = (content: string) => row({ role: 'user', content });
const assistantText = (content: string) => row({ role: 'assistant', content });
const assistantCall = (id: string, name = 'select_rows', args: unknown = { table: 't' }) =>
  row({ role: 'assistant', content: '', toolCallId: id, toolName: name, toolArgs: args });
const toolResult = (id: string, result: unknown = { ok: true }) =>
  row({ role: 'tool', content: '', toolCallId: id, toolName: 'select_rows', toolResult: result });

/** One user + one assistant/tool pair + one assistant reply, repeated. */
function syntheticHistory(rounds: number, padChars = 400): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(user(`wake ${i} ${'u'.repeat(padChars)}`));
    out.push(assistantCall(`call-${i}`, 'select_rows', { table: 't', pad: 'a'.repeat(padChars) }));
    out.push(toolResult(`call-${i}`, { rows: 'r'.repeat(padChars) }));
    out.push(assistantText(`done ${i} ${'d'.repeat(padChars)}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The property under test, stated once and reused everywhere.
// ---------------------------------------------------------------------------

/**
 * A sequence of STORED rows is pairing-valid when, after `toGatewayMessages`,
 * no assistant `tool_calls` is unanswered and no `role:'tool'` row is an orphan.
 * Both directions, because both are fatal at the gateway.
 */
function pairingViolations(messages: Message[]): string[] {
  const problems: string[] = [];
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCallId) calls.add(m.toolCallId);
    if (m.role === 'tool') {
      const id = m.toolCallId ?? '';
      if (!calls.has(id)) problems.push(`orphan tool result ${id} (no preceding assistant tool_call)`);
      answered.add(id);
    }
  }
  for (const id of calls) {
    if (!answered.has(id)) problems.push(`unanswered assistant tool_call ${id}`);
  }
  return problems;
}

/** Same property, but over what the GATEWAY was actually sent. */
type GwMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
};
function gatewayPairingViolations(messages: GwMessage[]): string[] {
  const problems: string[] = [];
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) calls.add(tc.id);
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      if (!calls.has(id)) problems.push(`orphan tool result ${id}`);
      answered.add(id);
    }
  }
  for (const id of calls) if (!answered.has(id)) problems.push(`unanswered tool_call ${id}`);
  return problems;
}

// ===========================================================================
// 1. trimOperatorHistory — pure
// ===========================================================================

describe('trimOperatorHistory — bounding', () => {
  it('bounds a long history: the gateway sees materially fewer messages than are stored', () => {
    const stored = syntheticHistory(200); // 800 rows
    const replayed = trimOperatorHistory(stored);

    expect(stored.length).toBe(800);
    expect(replayed.length).toBeLessThanOrEqual(OPERATOR_HISTORY_MAX_MESSAGES);
    expect(replayed.length).toBeLessThan(stored.length / 10);
    const chars = replayed.reduce((n, m) => n + replayCost(m), 0);
    expect(chars).toBeLessThanOrEqual(OPERATOR_HISTORY_MAX_CHARS);
  });

  it('keeps the MOST RECENT rows — it is a suffix, never a sample', () => {
    const stored = syntheticHistory(200);
    const replayed = trimOperatorHistory(stored);

    expect(replayed[replayed.length - 1]).toBe(stored[stored.length - 1]);
    const start = stored.indexOf(replayed[0]);
    expect(start).toBeGreaterThan(0);
    expect(stored.slice(start)).toEqual(replayed);
  });

  it('returns a short history untouched, by identity', () => {
    const stored = syntheticHistory(2, 10);
    expect(trimOperatorHistory(stored)).toBe(stored);
  });

  it('deletes nothing — the caller\'s array is not mutated', () => {
    const stored = syntheticHistory(200);
    const before = stored.slice();
    trimOperatorHistory(stored);
    expect(stored).toEqual(before);
    expect(stored.length).toBe(800);
  });

  it('respects an explicit character budget', () => {
    const stored = syntheticHistory(50, 100);
    const tight = trimOperatorHistory(stored, { maxChars: 2_000, maxMessages: 10_000 });
    const loose = trimOperatorHistory(stored, { maxChars: 40_000, maxMessages: 10_000 });
    expect(tight.length).toBeLessThan(loose.length);
    expect(tight.reduce((n, m) => n + replayCost(m), 0)).toBeLessThanOrEqual(2_000);
  });

  it('respects the message-count ceiling independently of characters', () => {
    // Tiny rows: the char budget alone would keep all of them.
    const stored: Message[] = [];
    for (let i = 0; i < 300; i++) stored.push(user(`x${i}`));
    const replayed = trimOperatorHistory(stored);
    expect(replayed.length).toBe(OPERATOR_HISTORY_MAX_MESSAGES);
  });
});

describe('trimOperatorHistory — PAIRING INTEGRITY (the load-bearing assertion)', () => {
  /**
   * The exact shape a naive cut gets wrong. A "keep the last N" rule with
   * N chosen anywhere inside a pair keeps the `role:'tool'` result and drops
   * the assistant `tool_calls` that produced it — the sequence the gateway
   * rejects outright.
   */
  it('never severs an assistant tool_call from its result, at ANY budget', () => {
    const stored = syntheticHistory(40, 50);

    // Sweep every plausible cut, including ones that land mid-pair.
    for (let maxMessages = 1; maxMessages <= stored.length; maxMessages++) {
      const replayed = trimOperatorHistory(stored, { maxChars: Number.MAX_SAFE_INTEGER, maxMessages });
      expect(pairingViolations(replayed)).toEqual([]);
      expect(replayed.length).toBeGreaterThan(0);
    }
    for (let maxChars = 1; maxChars <= 8_000; maxChars += 37) {
      const replayed = trimOperatorHistory(stored, { maxChars, maxMessages: Number.MAX_SAFE_INTEGER });
      expect(pairingViolations(replayed)).toEqual([]);
      expect(replayed.length).toBeGreaterThan(0);
    }
  });

  it('a naive last-N cut on the same history DOES violate the property (the control)', () => {
    // Proves the sweep above is testing something real, not a history whose
    // shape makes every cut safe.
    const stored = syntheticHistory(40, 50);
    let naiveViolations = 0;
    for (let n = 1; n <= stored.length; n++) {
      if (pairingViolations(stored.slice(stored.length - n)).length > 0) naiveViolations++;
    }
    expect(naiveViolations).toBeGreaterThan(0);
  });

  it('DIRECTION 1: never emits an orphan role:\'tool\' row whose call was trimmed', () => {
    // Budget deliberately sized so the arithmetic favours cutting between the
    // assistant call and its result.
    const stored = [
      user('old'.repeat(500)),
      assistantCall('call-A', 'select_rows', { pad: 'x'.repeat(3000) }),
      toolResult('call-A', { ok: true }),
      user('now'),
    ];
    const replayed = trimOperatorHistory(stored, { maxChars: 200, maxMessages: 3 });

    expect(replayed.some((m) => m.role === 'tool' && m.toolCallId === 'call-A')).toBe(false);
    expect(pairingViolations(replayed)).toEqual([]);
  });

  it('DIRECTION 2: never emits an assistant tool_call whose result was trimmed', () => {
    const stored = [
      user('old'),
      assistantCall('call-A'),
      toolResult('call-A', { huge: 'r'.repeat(5000) }),
      user('now'),
    ];
    // A budget that fits the assistant call but not its (much larger) result.
    const replayed = trimOperatorHistory(stored, { maxChars: 120, maxMessages: 3 });

    expect(replayed.some((m) => m.role === 'assistant' && m.toolCallId === 'call-A')).toBe(false);
    expect(pairingViolations(replayed)).toEqual([]);
  });

  it('keeps a pair WHOLE when it fits — trimming does not over-cut', () => {
    const stored = [user('old'.repeat(400)), assistantCall('call-A'), toolResult('call-A'), user('now')];
    const replayed = trimOperatorHistory(stored, { maxChars: 400, maxMessages: 10 });
    expect(replayed.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(pairingViolations(replayed)).toEqual([]);
  });

  it('handles a multi-tool-call step (several pairs in one assistant turn)', () => {
    const stored = [
      user('go'),
      assistantCall('c1'),
      toolResult('c1'),
      assistantCall('c2'),
      toolResult('c2'),
      assistantCall('c3'),
      toolResult('c3'),
      assistantText('summary'),
      user('now'),
    ];
    for (let maxMessages = 1; maxMessages <= stored.length; maxMessages++) {
      expect(
        pairingViolations(trimOperatorHistory(stored, { maxChars: Number.MAX_SAFE_INTEGER, maxMessages })),
      ).toEqual([]);
    }
  });

  it('drops an already-unanswered assistant tool_call rather than forwarding it', () => {
    // The approval-pause shape. runOperatorTurn refuses to start a turn while
    // one is outstanding, but trimming must not be the thing that reintroduces
    // it if that guard is ever bypassed.
    const stored = [user('a'), assistantCall('pending-1'), user('now')];
    const replayed = trimOperatorHistory(stored, { maxChars: Number.MAX_SAFE_INTEGER, maxMessages: 99 });
    expect(replayed.some((m) => m.toolCallId === 'pending-1')).toBe(false);
    expect(pairingViolations(replayed)).toEqual([]);
  });

  it('drops an already-orphaned tool result rather than forwarding it', () => {
    const stored = [user('a'), toolResult('ghost-1'), assistantText('b'), user('now')];
    const replayed = trimOperatorHistory(stored, { maxChars: Number.MAX_SAFE_INTEGER, maxMessages: 99 });
    expect(replayed.some((m) => m.role === 'tool')).toBe(false);
    expect(pairingViolations(replayed)).toEqual([]);
  });

  it('FUZZ: 400 random histories x random budgets are always pairing-valid', () => {
    // Deterministic PRNG so a failure is reproducible.
    let s = 0x2f6e2b1;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    for (let iter = 0; iter < 400; iter++) {
      const stored: Message[] = [];
      let openCall: string | null = null;
      const len = 3 + Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) {
        if (openCall && rnd() < 0.8) {
          stored.push(toolResult(openCall, { r: 'x'.repeat(Math.floor(rnd() * 300)) }));
          openCall = null;
          continue;
        }
        const pick = rnd();
        if (pick < 0.3) stored.push(user('u'.repeat(Math.floor(rnd() * 300))));
        else if (pick < 0.6) stored.push(assistantText('a'.repeat(Math.floor(rnd() * 300))));
        else if (!openCall) {
          openCall = `c-${iter}-${i}`;
          stored.push(assistantCall(openCall, 'select_rows', { p: 'x'.repeat(Math.floor(rnd() * 300)) }));
        } else {
          stored.push(user('filler'));
        }
      }
      stored.push(user('wake'));

      const replayed = trimOperatorHistory(stored, {
        maxChars: 1 + Math.floor(rnd() * 6000),
        maxMessages: 1 + Math.floor(rnd() * 40),
      });
      const violations = pairingViolations(replayed);
      if (violations.length > 0) {
        throw new Error(`iter ${iter}: ${violations.join(', ')} :: ${stored.map((m) => `${m.role}:${m.toolCallId ?? ''}`).join('|')}`);
      }
      expect(replayed.length).toBeGreaterThan(0);
    }
  });

  it('always replays the wake message, even when it alone blows the budget', () => {
    // The wake message is persisted BEFORE history is read, so it is always the
    // last row. With an 8000-char scratchpad it can exceed a small budget on
    // its own; replaying nothing would leave the model with no instruction.
    const wake = user('W'.repeat(12_000));
    const stored = [...syntheticHistory(5, 100), wake];
    const replayed = trimOperatorHistory(stored, { maxChars: 100, maxMessages: 100 });
    expect(replayed[replayed.length - 1]).toBe(wake);
    expect(replayed.length).toBeGreaterThan(0);
  });

  it('empty history stays empty', () => {
    expect(trimOperatorHistory([])).toEqual([]);
  });
});

// ===========================================================================
// 2. runAgentTurn — what actually reaches the gateway
// ===========================================================================

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/** A gateway that just answers with text, recording every request body. */
function recordingGateway() {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    return {
      ok: true,
      body: makeSseStream([
        { choices: [{ delta: { content: 'ack' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies };
}

function sentMessages(body: string): GwMessage[] {
  return (JSON.parse(body) as { messages: GwMessage[] }).messages;
}

function baseInput(userId: string, userMessage: string) {
  return {
    conversationId: 'conv-1',
    userId,
    jwt: 'jwt',
    userMessage,
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue({} as never);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
});

describe('runAgentTurn — operator history is bounded at the gateway', () => {
  it('an operator turn sends materially fewer messages than are stored', async () => {
    const stored = [...syntheticHistory(200), user('WAKE')];
    mockListMessages.mockResolvedValue(stored);
    const { bodies } = recordingGateway();

    const events = await collect(runAgentTurn(baseInput(OPERATOR_USER, 'WAKE')));

    // The turn works end to end — trimming does not error at the gateway.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const sent = sentMessages(bodies[0]);
    expect(sent[0].role).toBe('system');
    const replayed = sent.length - 1;
    expect(stored.length).toBe(801);
    expect(replayed).toBeLessThanOrEqual(OPERATOR_HISTORY_MAX_MESSAGES);
    expect(replayed).toBeLessThan(stored.length / 10);
    expect(gatewayPairingViolations(sent)).toEqual([]);
  });

  it('the wake header and scratchpad still arrive after trimming', async () => {
    // The wake message carries the platform header plus up to 8000 chars of
    // scratchpad. Trimming must never be what drops the agent's continuity.
    const wakeText = [
      '=== OPERATOR WAKE (platform-authored) ===',
      `organization_id: ${ORG_ID}`,
      'prompt_version: operator-wake/2026-08-06.1',
      '=== END OPERATOR WAKE ===',
      '--- YOUR SCRATCHPAD (you wrote this) ---',
      'S'.repeat(8000),
      '--- END SCRATCHPAD ---',
    ].join('\n');
    const stored = [...syntheticHistory(300), user(wakeText)];
    mockListMessages.mockResolvedValue(stored);
    const { bodies } = recordingGateway();

    await collect(runAgentTurn(baseInput(OPERATOR_USER, wakeText)));

    const sent = sentMessages(bodies[0]);
    const last = sent[sent.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe(wakeText);
    expect(last.content).toContain('=== OPERATOR WAKE (platform-authored) ===');
    expect(last.content).toContain(`organization_id: ${ORG_ID}`);
    expect(last.content).toContain('S'.repeat(8000));
  });

  it('a pair straddling the cut is never split at the gateway', async () => {
    // History padded so the budget lands inside the middle pairs.
    const stored = [...syntheticHistory(60, 900), user('WAKE')];
    mockListMessages.mockResolvedValue(stored);
    const { bodies } = recordingGateway();

    await collect(runAgentTurn(baseInput(OPERATOR_USER, 'WAKE')));

    const sent = sentMessages(bodies[0]);
    expect(gatewayPairingViolations(sent)).toEqual([]);
    // And it really did cut inside the transcript, not just pass it through.
    expect(sent.length - 1).toBeLessThan(stored.length);
  });
});

describe('runAgentTurn — the human assistant is untouched', () => {
  it('a NON-operator conversation replays EVERY stored message, in order', async () => {
    const stored = [...syntheticHistory(200), user('hello again')];
    mockListMessages.mockResolvedValue(stored);
    const { bodies } = recordingGateway();

    await collect(runAgentTurn(baseInput(HUMAN_USER, 'hello again')));

    const sent = sentMessages(bodies[0]);
    expect(sent.length).toBe(stored.length + 1); // + system prompt
  });

  it('a NON-operator conversation replays byte-identically to toGatewayMessages(full history)', async () => {
    const stored = [...syntheticHistory(30), user('hello again')];

    mockListMessages.mockResolvedValue(stored);
    const human = recordingGateway();
    await collect(runAgentTurn(baseInput(HUMAN_USER, 'hello again')));
    const humanSent = sentMessages(human.bodies[0]);

    // Reference: what the loop would send with NO trimming at all — every
    // stored row, in order, mapped exactly as toGatewayMessages maps them.
    const expected = stored.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: JSON.stringify(m.toolResult ?? {}) };
      }
      if (m.role === 'assistant' && m.toolCallId) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: [
            {
              id: m.toolCallId,
              type: 'function',
              function: { name: m.toolName ?? '', arguments: JSON.stringify(m.toolArgs ?? {}) },
            },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    expect(humanSent.slice(1)).toEqual(expected);
    expect(JSON.stringify(humanSent.slice(1))).toBe(JSON.stringify(expected));
  });

  it('the same history is bounded for the operator and unbounded for the human', async () => {
    // One assertion, both sides — the operator-only claim stated directly.
    const stored = [...syntheticHistory(200), user('go')];

    mockListMessages.mockResolvedValue(stored);
    const operator = recordingGateway();
    await collect(runAgentTurn(baseInput(OPERATOR_USER, 'go')));
    const operatorCount = sentMessages(operator.bodies[0]).length;

    vi.clearAllMocks();
    mockAppendMessage.mockResolvedValue({} as never);
    mockListMessages.mockResolvedValue(stored);
    mockGetRecentToolArgs.mockResolvedValue([]);
    mockGetConversation.mockResolvedValue(null);
    mockUpdateConversationTitle.mockResolvedValue(null);
    const human = recordingGateway();
    await collect(runAgentTurn(baseInput(HUMAN_USER, 'go')));
    const humanCount = sentMessages(human.bodies[0]).length;

    expect(humanCount).toBe(stored.length + 1);
    expect(operatorCount).toBeLessThan(humanCount / 10);
  });

  it('nothing is deleted — trimming never calls into the store beyond listMessages', async () => {
    const stored = [...syntheticHistory(200), user('go')];
    mockListMessages.mockResolvedValue(stored);
    recordingGateway();

    await collect(runAgentTurn(baseInput(OPERATOR_USER, 'go')));

    // The only writes are the ordinary turn appends (user + assistant).
    for (const call of mockAppendMessage.mock.calls) {
      expect(['user', 'assistant']).toContain((call[2] as { role: string }).role);
    }
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });
});
