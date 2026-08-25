import { describe, it, expect } from 'vitest';
import {
  responsesRequestToChatCompletion, chatCompletionResponseToResponses, BUILTIN_TOOL_TYPES,
} from './responses-translate.js';

describe('responsesRequestToChatCompletion', () => {
  it('maps string input to a user message', () => {
    const cc = responsesRequestToChatCompletion(
      { model: 'openai/gpt-4o', input: 'hi' } as any, null, null, null);
    expect(cc.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('flattens prior input + prior output then current input', () => {
    const cc = responsesRequestToChatCompletion(
      { model: 'm', input: [{ type: 'message', role: 'user', content: 'turn 2' }] } as any,
      [{ role: 'user', content: 'turn 1' }],
      [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'turn 1 reply' }] }],
      null,
    );
    expect(cc.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((cc.messages[1] as any).content).toBe('turn 1 reply');
  });
  it('drops built-in tools (caller is responsible for rejecting)', () => {
    const cc = responsesRequestToChatCompletion(
      { model: 'm', input: 'x', tools: [{ type: 'web_search_preview' }, { type: 'function', name: 'now', parameters: {} }] } as any,
      null, null, null);
    expect(cc.tools).toHaveLength(1);
    expect((cc.tools as any[])[0].function.name).toBe('now');
  });
});

describe('chatCompletionResponseToResponses', () => {
  it('produces a Responses-shaped body', () => {
    const body = chatCompletionResponseToResponses({
      id: 'rsp_x', model: 'm', createdAt: 123, previousResponseId: null,
      cc: {
        id: 'cc_x',
        choices: [{ message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      } as any,
    });
    expect(body.id).toBe('rsp_x');
    expect(body.status).toBe('completed');
    expect(body.output[0].content[0]).toEqual({ type: 'output_text', text: 'hi back' });
    expect(body.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });
  it('preserves empty-string content as an output_text item', () => {
    const body = chatCompletionResponseToResponses({
      id: 'rsp_y', model: 'm', createdAt: 0, previousResponseId: null,
      cc: { id: 'cc_y', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 0 } } as any,
    });
    expect(body.output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: '' }] });
  });
});

it('BUILTIN_TOOL_TYPES enumerates the four deferred tools', () => {
  expect(BUILTIN_TOOL_TYPES).toEqual(['web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview']);
});

describe('namespace tools', () => {
  const nsTool = {
    type: 'namespace',
    name: 'mcp__butterbase',
    description: 'Tools in the mcp__butterbase namespace.',
    tools: [
      { type: 'function', name: 'manage_app', description: 'manage apps', parameters: { type: 'object' } },
      { type: 'function', name: 'select_rows', description: 'read rows', parameters: { type: 'object' } },
    ],
  };

  it('expands namespace tools into flattened chat-completions functions', () => {
    const cc = responsesRequestToChatCompletion(
      { model: 'm', input: 'x', tools: [nsTool, { type: 'function', name: 'now', parameters: {} }] } as any,
      null, null, null);
    expect((cc.tools as any[]).map((t) => t.function.name)).toEqual([
      'mcp__butterbase__manage_app', 'mcp__butterbase__select_rows', 'now',
    ]);
    expect((cc.tools as any[])[0].function.description).toBe('manage apps');
    expect((cc.tools as any[])[0].function.parameters).toEqual({ type: 'object' });
  });

  it('records the flattened -> {namespace, name} mapping in the supplied map', () => {
    const map = new Map<string, { namespace: string; name: string }>();
    responsesRequestToChatCompletion(
      { model: 'm', input: 'x', tools: [nsTool, { type: 'function', name: 'now', parameters: {} }] } as any,
      null, null, null, map);
    expect(map.get('mcp__butterbase__manage_app')).toEqual({ namespace: 'mcp__butterbase', name: 'manage_app' });
    expect(map.get('mcp__butterbase__select_rows')).toEqual({ namespace: 'mcp__butterbase', name: 'select_rows' });
    expect(map.has('now')).toBe(false);
  });

  it('still drops built-in tools nested alongside a namespace tool', () => {
    const cc = responsesRequestToChatCompletion(
      { model: 'm', input: 'x', tools: [{ type: 'file_search' }, nsTool] } as any,
      null, null, null);
    expect((cc.tools as any[]).map((t) => t.function.name)).toEqual([
      'mcp__butterbase__manage_app', 'mcp__butterbase__select_rows',
    ]);
  });

  it('re-flattens a namespaced function_call arriving in input history', () => {
    const map = new Map<string, { namespace: string; name: string }>();
    const cc = responsesRequestToChatCompletion(
      {
        model: 'm',
        tools: [nsTool],
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'manage_app', namespace: 'mcp__butterbase', arguments: '{"a":1}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          { type: 'message', role: 'user', content: 'and now?' },
        ],
      } as any,
      null, null, null, map);
    expect((cc.messages[0] as any).tool_calls[0].function.name).toBe('mcp__butterbase__manage_app');
    expect((cc.messages[1] as any).tool_call_id).toBe('call_1');
  });

  it('re-flattens a namespaced call whose namespace field was stripped, via the map', () => {
    const map = new Map<string, { namespace: string; name: string }>();
    const cc = responsesRequestToChatCompletion(
      {
        model: 'm',
        tools: [nsTool],
        input: [{ type: 'function_call', call_id: 'call_1', name: 'manage_app', arguments: '{}' }],
      } as any,
      null, null, null, map);
    expect((cc.messages[0] as any).tool_calls[0].function.name).toBe('mcp__butterbase__manage_app');
  });

  it('emits separate name + namespace on the non-streaming response path', () => {
    const map = new Map([['mcp__butterbase__manage_app', { namespace: 'mcp__butterbase', name: 'manage_app' }]]);
    const body = chatCompletionResponseToResponses({
      id: 'rsp_abcdefgh', model: 'm', createdAt: 1, previousResponseId: null,
      cc: {
        id: 'cc1',
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'mcp__butterbase__manage_app', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'plain', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      } as any,
      namespaceTools: map,
    });
    expect(body.output[0]).toEqual({
      type: 'function_call', call_id: 'call_1', name: 'manage_app',
      namespace: 'mcp__butterbase', arguments: '{}',
    });
    expect(body.output[1]).toEqual({
      type: 'function_call', call_id: 'call_2', name: 'plain', arguments: '{}',
    });
  });
});
