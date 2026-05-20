import { describe, it, expect } from 'vitest';
import type { ChatMessage, ChatContentPart } from './types';

describe('ChatMessage', () => {
  it('accepts plain string content', () => {
    const m: ChatMessage = { role: 'user', content: 'hi' };
    expect(typeof m.content).toBe('string');
  });

  it('accepts array of content parts (multimodal)', () => {
    const m: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        { type: 'video_url', video_url: { url: 'https://x/y.mp4' } },
      ],
    };
    expect(Array.isArray(m.content)).toBe(true);
    expect((m.content as ChatContentPart[]).length).toBe(3);
  });

  it('accepts tool role with tool_call_id', () => {
    const m: ChatMessage = { role: 'tool', content: 'result', tool_call_id: 'call_1' };
    expect(m.tool_call_id).toBe('call_1');
  });

  it('image_url accepts detail hint', () => {
    const m: ChatMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'high' } }],
    };
    expect(Array.isArray(m.content)).toBe(true);
  });
});
