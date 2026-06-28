import { describe, it, expect } from 'vitest';
import {
  messagesRequestToChatCompletion,
  chatCompletionResponseToMessages,
  UnsupportedTranslationError,
} from './messages-translate.js';
import type { MessagesRequest } from './messages-schema.js';

const baseReq: MessagesRequest = {
  model: 'openrouter/anthropic/claude-3.5-sonnet',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
};

describe('messagesRequestToChatCompletion', () => {
  it('maps system prompt + string content', () => {
    const cc = messagesRequestToChatCompletion({ ...baseReq, system: 'You are X.' }, null);
    expect(cc.messages[0]).toEqual({ role: 'system', content: 'You are X.' });
    expect(cc.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(cc.max_tokens).toBe(1024);
  });
  it('maps tool_use to tool_calls and tool_result to tool role', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [
        { role: 'user', content: 'use a tool' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'now', input: {} } as any] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '12:00' } as any] },
      ],
    }, null);
    expect((cc.messages[1] as any).tool_calls[0]).toMatchObject({
      id: 'tu_1', type: 'function', function: { name: 'now', arguments: '{}' },
    });
    expect(cc.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'tu_1', content: '12:00' });
  });
  it('maps tool_choice any -> required and tool name', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      tools: [{ name: 'now', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    } as MessagesRequest, null);
    expect(cc.tool_choice).toBe('required');
  });
  it('maps thinking to reasoning_effort', () => {
    const cc = messagesRequestToChatCompletion(baseReq, { enabled: true, effort: 'high', budgetTokens: 24000 });
    expect((cc as any).reasoning_effort).toBe('high');
  });
  it('maps tool_choice auto', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      tools: [{ name: 'now', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    } as MessagesRequest, null);
    expect(cc.tool_choice).toBe('auto');
  });
  it('maps tool_choice tool with name', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      tools: [{ name: 'now', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'now' },
    } as MessagesRequest, null);
    expect(cc.tool_choice).toEqual({ type: 'function', function: { name: 'now' } });
  });
});

describe('chatCompletionResponseToMessages', () => {
  it('maps text content + stop_reason', () => {
    const body = chatCompletionResponseToMessages('m', {
      id: 'cc_1',
      choices: [{ message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    } as any);
    expect(body.content).toEqual([{ type: 'text', text: 'hi back' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });
  it('maps tool_calls to tool_use blocks', () => {
    const body = chatCompletionResponseToMessages('m', {
      id: 'cc_2',
      choices: [{
        message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'now', arguments: '{"x":1}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    } as any);
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([{ type: 'tool_use', id: 'tc_1', name: 'now', input: { x: 1 } }]);
  });
  it('finish_reason length -> max_tokens', () => {
    const body = chatCompletionResponseToMessages('m', {
      id: 'cc_3',
      choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    } as any);
    expect(body.stop_reason).toBe('max_tokens');
  });
  it('finish_reason content_filter -> stop_sequence', () => {
    const body = chatCompletionResponseToMessages('m', {
      id: 'cc_4',
      choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    } as any);
    expect(body.stop_reason).toBe('stop_sequence');
  });
  it('finish_reason function_call -> tool_use', () => {
    const body = chatCompletionResponseToMessages('m', {
      id: 'cc_5',
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'function_call' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    } as any);
    expect(body.stop_reason).toBe('tool_use');
  });
});

describe('UnsupportedTranslationError', () => {
  it('thrown on image content in tool_result', () => {
    expect(() => messagesRequestToChatCompletion({
      ...baseReq,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image' } as any] } as any] }],
    } as MessagesRequest, null)).toThrow(UnsupportedTranslationError);
  });
});
