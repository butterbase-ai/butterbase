/**
 * Office skill seams in the operator loop.
 *
 * The loop stays the single source of tool names: a seam on the turn decides
 * whether a tool is OFFERED, and the injected executor decides whether a call
 * ever reaches Office code. This file pins both sides:
 *
 *   - no executor => the tool is absent from the model's catalog;
 *   - readOnly   => a consequential tool returns `read_only_test` and creates
 *                   no approval row;
 *   - `manage_integrations` `execute_read` goes through the org reader, never
 *                   the app-scoped MCP path.
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
vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));
vi.mock('../approvals-store.js', () => ({ createApproval: vi.fn(), checkTrust: vi.fn() }));
vi.mock('../../locked-key-access.js', () => ({
  assertOperatorKeyArguments: vi.fn(async () => {}),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';
import { operatorUserId } from '../operator-store.js';
import {
  SKILL_CREATOR_TOOL, RUN_SKILL_SCRIPT_TOOL,
} from '../tool-catalog.js';
import type {
  ActiveSkillContext, IntegrationReader, SkillCreatorExecutor, SkillScriptExecutor,
} from '../skill-types.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const SERVICE_KEY = 'bb_sk_operatorSERVICEKEYoperatorSERVICEKEY';
const HUMAN_USER = 'cognito-sub-abc';

const stubPool = {} as pg.Pool;
const stubMessage = {
  id: 'msg-stub', conversationId: 'conv-1', role: 'user' as const, content: '',
  toolCallId: null, toolName: null, toolArgs: null, toolResult: null,
  modelUsed: null, createdAt: new Date(),
};

const ACTIVE_SKILL: ActiveSkillContext = {
  skillId: 'skill-1',
  versionId: 'version-1',
  runId: 'run-1',
  entrypoint: 'scripts/check.py',
};

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(encoder.encode(lines)); c.close(); },
  });
}
const gatewayResponse = (deltas: object[]) => ({ ok: true, body: makeSseStream(deltas) } as unknown as Response);

function oneToolCallThenStop(name: string, args: unknown) {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    if (bodies.length === 1) {
      return gatewayResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    }
    return gatewayResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies };
}

function toolNamesSent(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
  return (parsed.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
}

const officeAccess = async () => ({
  allowed: true, reason: null, approvalMode: 'consequential' as const,
});

function operatorInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: SERVICE_KEY,
    userMessage: 'Skill wake.',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    accessGuard: officeAccess,
    ...overrides,
  };
}

function humanInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1', userId: HUMAN_USER, jwt: 'user-jwt',
    userMessage: 'Also check the Google Sheet every morning.',
    model: 'claude-sonnet-4-5', pool: stubPool,
    organizationId: ORG_ID, ...overrides,
  };
}

const resultOf = (events: LoopEvent[]) =>
  events.find((e) => e.type === 'tool_result') as Extract<LoopEvent, { type: 'tool_result' }> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
});

describe('tool availability follows the supplied seams', () => {
  it('offers skill_creator only when a creator executor is supplied', async () => {
    const without = oneToolCallThenStop('manage_app', { action: 'list' });
    await collect(runAgentTurn(humanInput()));
    expect(toolNamesSent(without.bodies[0])).not.toContain(SKILL_CREATOR_TOOL);

    const withCreator = oneToolCallThenStop('manage_app', { action: 'list' });
    const skillCreator = vi.fn() as unknown as SkillCreatorExecutor;
    await collect(runAgentTurn(humanInput({ skillCreator })));
    expect(toolNamesSent(withCreator.bodies[0])).toContain(SKILL_CREATOR_TOOL);
    expect(skillCreator).not.toHaveBeenCalled();
  });

  it('offers run_skill_script only with an active skill and script executor', async () => {
    const script = vi.fn() as unknown as SkillScriptExecutor;

    const executorOnly = oneToolCallThenStop('manage_app', { action: 'list' });
    await collect(runAgentTurn(operatorInput({ skillScript: script })));
    expect(toolNamesSent(executorOnly.bodies[0])).not.toContain(RUN_SKILL_SCRIPT_TOOL);

    const skillOnly = oneToolCallThenStop('manage_app', { action: 'list' });
    await collect(runAgentTurn(operatorInput({ activeSkill: ACTIVE_SKILL })));
    expect(toolNamesSent(skillOnly.bodies[0])).not.toContain(RUN_SKILL_SCRIPT_TOOL);

    const both = oneToolCallThenStop('manage_app', { action: 'list' });
    await collect(runAgentTurn(operatorInput({ skillScript: script, activeSkill: ACTIVE_SKILL })));
    expect(toolNamesSent(both.bodies[0])).toContain(RUN_SKILL_SCRIPT_TOOL);
    expect(script).not.toHaveBeenCalled();
  });
});

describe('skill_creator dispatch', () => {
  it('dispatches skill_creator with the turn jwt, org and user', async () => {
    const created = {
      skill_id: 'skill-1', version_id: 'version-1', version: 1,
      summary: 'Reads the Customers sheet every morning.',
      change_summary: null, test_run_id: 'run-9', status: 'testing' as const,
    };
    const skillCreator = vi.fn(async () => created) as unknown as SkillCreatorExecutor;
    const { bodies } = oneToolCallThenStop(SKILL_CREATOR_TOOL, {
      request: 'also check the Google Sheet every morning',
      timezone: 'Europe/London',
    });

    const events = await collect(runAgentTurn(humanInput({ skillCreator })));

    expect(skillCreator).toHaveBeenCalledWith({
      args: { request: 'also check the Google Sheet every morning', timezone: 'Europe/London' },
      organizationId: ORG_ID,
      userId: HUMAN_USER,
      jwt: 'user-jwt',
      model: 'claude-sonnet-4-5',
    });
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const payload = resultOf(events)!.result as { content: Array<{ type: string; text: string }> };
    expect(JSON.parse(payload.content[0].text)).toEqual(created);
    expect(bodies).toHaveLength(2);
  });
});

describe('run_skill_script dispatch', () => {
  it('dispatches run_skill_script with the active skill and returns stdout', async () => {
    const skillScript = vi.fn(async () => ({
      stdout: '{"missing":3}', stderr: '', exitCode: 0,
    })) as unknown as SkillScriptExecutor;
    oneToolCallThenStop(RUN_SKILL_SCRIPT_TOOL, {
      entrypoint: 'scripts/check.py', input: { rows: [{ id: 1 }] },
    });

    const events = await collect(runAgentTurn(operatorInput({
      skillScript, activeSkill: ACTIVE_SKILL,
    })));

    expect(skillScript).toHaveBeenCalledWith({
      skill: ACTIVE_SKILL,
      args: { entrypoint: 'scripts/check.py', input: { rows: [{ id: 1 }] } },
    });
    const payload = resultOf(events)!.result as { content: Array<{ text: string }> };
    expect(JSON.parse(payload.content[0].text)).toEqual({
      stdout: '{"missing":3}', stderr: '', exit_code: 0,
    });
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('refuses an entrypoint that leaves the package', async () => {
    const skillScript = vi.fn() as unknown as SkillScriptExecutor;
    oneToolCallThenStop(RUN_SKILL_SCRIPT_TOOL, { entrypoint: '../evil.py' });

    const events = await collect(runAgentTurn(operatorInput({
      skillScript, activeSkill: ACTIVE_SKILL,
    })));

    expect(skillScript).not.toHaveBeenCalled();
    expect(resultOf(events)!.error).toMatch(/invalid_entrypoint/);
  });
});

describe('manage_integrations execute_read', () => {
  it('dispatches execute_read through the injected reader', async () => {
    const reader = vi.fn(async () => ({ content: { values: [['Ada']] } })) as unknown as IntegrationReader;
    oneToolCallThenStop('manage_integrations', {
      action: 'execute_read',
      tool_slug: 'GOOGLESHEETS_GET_VALUES',
      params: { spreadsheet_id: 'sheet-1', range: 'Customers!A1:B10' },
    });

    const events = await collect(runAgentTurn(operatorInput({ integrationReader: reader })));

    expect(reader).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      toolSlug: 'GOOGLESHEETS_GET_VALUES',
      params: { spreadsheet_id: 'sheet-1', range: 'Customers!A1:B10' },
      readOnly: false,
    });
    expect(resultOf(events)!.result).toEqual({ values: [['Ada']] });
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('passes readOnly through to the reader during a test run', async () => {
    const reader = vi.fn(async () => ({ content: { values: [] } })) as unknown as IntegrationReader;
    oneToolCallThenStop('manage_integrations', {
      action: 'execute_read', tool_slug: 'GOOGLESHEETS_GET_VALUES', params: {},
    });

    await collect(runAgentTurn(operatorInput({ integrationReader: reader, readOnly: true })));

    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });
});

describe('read-only test mode', () => {
  it('returns read_only_test and creates no approval for a consequential tool', async () => {
    const { bodies } = oneToolCallThenStop('manage_app', { action: 'delete', app_id: 'app-1' });

    const events = await collect(runAgentTurn(operatorInput({ readOnly: true })));

    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(resultOf(events)!.result).toEqual({
      blocked: true, code: 'read_only_test', tool: 'manage_app',
    });
    // The model reads the refusal and the turn continues.
    expect(bodies).toHaveLength(2);
  });
});

describe('OSS mode', () => {
  it('leaves OSS mode without skill tools or an org reader', async () => {
    const { bodies } = oneToolCallThenStop('manage_integrations', {
      action: 'execute_read', tool_slug: 'GOOGLESHEETS_GET_VALUES', params: {},
    });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(toolNamesSent(bodies[0])).not.toContain(SKILL_CREATOR_TOOL);
    expect(toolNamesSent(bodies[0])).not.toContain(RUN_SKILL_SCRIPT_TOOL);
    expect(resultOf(events)!.error).toBe('integration_reader_unavailable');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});
