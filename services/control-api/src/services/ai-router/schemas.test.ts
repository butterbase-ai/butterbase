import { describe, it, expect } from 'vitest';
import { contentPartSchema, toolCallSchema } from './schemas.js';

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
