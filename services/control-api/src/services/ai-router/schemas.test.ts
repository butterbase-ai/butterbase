import { describe, it, expect } from 'vitest';
import { contentPartSchema, toolCallSchema, messageSchema, chatCompletionRequestSchema, embeddingRequestSchema } from './schemas.js';

describe('contentPartSchema', () => {
  it('accepts a text part', () => {
    expect(contentPartSchema.parse({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('accepts an image_url part', () => {
    const part = { type: 'image_url', image_url: { url: 'https://x/i.png' } };
    expect(contentPartSchema.parse(part)).toEqual(part);
  });

  it('accepts unknown part types via passthrough', () => {
    const part = { type: 'input_audio', input_audio: { data: 'abc', format: 'mp3' } };
    expect(contentPartSchema.parse(part)).toMatchObject({ type: 'input_audio' });
  });
});

describe('toolCallSchema', () => {
  it('accepts a well-formed function tool call', () => {
    const call = {
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    };
    expect(toolCallSchema.parse(call)).toEqual(call);
  });

  it('rejects a tool call missing function.arguments', () => {
    const bad = { id: 'call_1', type: 'function', function: { name: 'x' } };
    expect(() => toolCallSchema.parse(bad)).toThrow();
  });

  it('rejects a tool call with wrong type literal', () => {
    const bad = {
      id: 'c',
      type: 'tool',
      function: { name: 'x', arguments: '{}' },
    };
    expect(() => toolCallSchema.parse(bad)).toThrow();
  });
});

describe('messageSchema — system / user', () => {
  it('accepts a system message', () => {
    expect(messageSchema.parse({ role: 'system', content: 'be terse' })).toMatchObject({
      role: 'system',
      content: 'be terse',
    });
  });

  it('accepts a user message with array content', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    expect(messageSchema.parse(msg)).toMatchObject({ role: 'user' });
  });

  it('rejects a user message with null content', () => {
    expect(() => messageSchema.parse({ role: 'user', content: null })).toThrow();
  });
});

describe('messageSchema — assistant', () => {
  it('accepts assistant with string content and no tool_calls', () => {
    const msg = { role: 'assistant', content: 'hello' };
    expect(messageSchema.parse(msg)).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  it('accepts assistant with content:null when tool_calls present', () => {
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    };
    const parsed = messageSchema.parse(msg);
    expect(parsed).toMatchObject({ role: 'assistant', content: null });
    expect((parsed as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
  });

  it('rejects assistant with content:null and no tool_calls', () => {
    expect(() =>
      messageSchema.parse({ role: 'assistant', content: null }),
    ).toThrow(/tool_calls/i);
  });

  it('rejects assistant with content:null and empty tool_calls array', () => {
    expect(() =>
      messageSchema.parse({ role: 'assistant', content: null, tool_calls: [] }),
    ).toThrow(/tool_calls/i);
  });

  it('preserves refusal field on assistant message', () => {
    const msg = { role: 'assistant', content: 'I cannot help with that.', refusal: 'safety_policy' };
    const parsed = messageSchema.parse(msg);
    expect(parsed).toMatchObject({ role: 'assistant', refusal: 'safety_policy' });
  });
});

describe('messageSchema — tool', () => {
  it('accepts a tool message with tool_call_id', () => {
    const msg = { role: 'tool', tool_call_id: 'c1', content: '{"temp_c":18}' };
    expect(messageSchema.parse(msg)).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
    });
  });

  it('rejects a tool message missing tool_call_id', () => {
    expect(() =>
      messageSchema.parse({ role: 'tool', content: '{"temp_c":18}' }),
    ).toThrow();
  });
});

describe('messageSchema — legacy function role', () => {
  it('accepts a legacy function message with name + content', () => {
    const msg = { role: 'function', name: 'get_weather', content: '{"temp_c":18}' };
    expect(messageSchema.parse(msg)).toMatchObject({ role: 'function', name: 'get_weather' });
  });
});

describe('messageSchema — unknown role', () => {
  it('rejects an unknown role', () => {
    expect(() => messageSchema.parse({ role: 'wizard', content: 'hi' })).toThrow();
  });
});

describe('chatCompletionRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const req = {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(chatCompletionRequestSchema.parse(req)).toMatchObject({
      model: 'openai/gpt-4o-mini',
    });
  });

  it('preserves tools and tool_choice', () => {
    const req = {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    };
    const parsed = chatCompletionRequestSchema.parse(req);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tool_choice).toBe('auto');
  });

  it('preserves a named-function tool_choice', () => {
    const req = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    };
    const parsed = chatCompletionRequestSchema.parse(req);
    expect(parsed.tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('preserves a full tool round-trip message array', () => {
    const req = {
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp_c":18}' },
      ],
    };
    const parsed = chatCompletionRequestSchema.parse(req);
    expect(parsed.messages).toHaveLength(3);
    const assistant = parsed.messages[1] as { tool_calls?: unknown[] };
    expect(assistant.tool_calls).toHaveLength(1);
    const tool = parsed.messages[2] as { tool_call_id?: string };
    expect(tool.tool_call_id).toBe('c1');
  });

  it('passes through unknown top-level fields (e.g. provider)', () => {
    const req = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      provider: { order: ['anthropic'], allow_fallbacks: false },
    };
    const parsed = chatCompletionRequestSchema.parse(req) as Record<string, unknown>;
    expect(parsed.provider).toEqual({ order: ['anthropic'], allow_fallbacks: false });
  });

  it('rejects temperature out of range', () => {
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        temperature: 3,
      }),
    ).toThrow();
  });
});

describe('embeddingRequestSchema', () => {
  it('accepts a string input', () => {
    expect(
      embeddingRequestSchema.parse({ model: 'text-embedding-3-small', input: 'hi' }),
    ).toMatchObject({ model: 'text-embedding-3-small' });
  });

  it('accepts a string-array input', () => {
    expect(
      embeddingRequestSchema.parse({ model: 'm', input: ['a', 'b'] }),
    ).toMatchObject({ input: ['a', 'b'] });
  });
});
