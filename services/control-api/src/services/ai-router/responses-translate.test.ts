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
});

it('BUILTIN_TOOL_TYPES enumerates the four deferred tools', () => {
  expect(BUILTIN_TOOL_TYPES).toEqual(['web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview']);
});
