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

describe('image blocks', () => {
  it('maps a URL image in user content to an image_url part', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ] as any,
      }],
    } as MessagesRequest, null);
    expect(cc.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    });
  });

  it('maps a base64 image in user content to a data URI', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] as any,
      }],
    } as MessagesRequest, null);
    expect((cc.messages[0] as any).content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
  });

  it('keeps a single text block as plain string content', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] as any }],
    } as MessagesRequest, null);
    expect(cc.messages[0]).toEqual({ role: 'user', content: 'plain' });
  });

  it('carries an image inside tool_result through as a follow-up user message', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'screenshot', input: {} }] as any },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [
              { type: 'text', text: 'here it is' },
              { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
            ],
          }] as any,
        },
      ],
    } as MessagesRequest, null);
    // tool message keeps the text and must directly follow the tool_calls message
    expect(cc.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'tu_1', content: 'here it is' });
    // the image survives as a subsequent user turn
    expect((cc.messages[2] as any).role).toBe('user');
    expect((cc.messages[2] as any).content).toContainEqual({
      type: 'image_url', image_url: { url: 'https://example.com/shot.png' },
    });
  });

  it('emits tool_result messages before sibling user text, whatever the block order', () => {
    const cc = messagesRequestToChatCompletion({
      ...baseReq,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'now', input: {} }] as any },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'thanks' },
            { type: 'tool_result', tool_use_id: 'tu_1', content: '12:00' },
          ] as any,
        },
      ],
    } as MessagesRequest, null);
    expect(cc.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'tu_1' });
    expect(cc.messages[2]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('still rejects a tool_result content shape it cannot represent', () => {
    expect(() => messagesRequestToChatCompletion({
      ...baseReq,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 42 as any } as any] }],
    } as MessagesRequest, null)).toThrow(UnsupportedTranslationError);
  });
});
