import { describe, it, expect } from 'vitest';

const URL = process.env.STAGING_GATEWAY_URL;
const KEY = process.env.STAGING_GATEWAY_KEY;
const RUN = URL && KEY;

describe.skipIf(!RUN)('v2 gateway e2e', () => {
  it('/v1/messages non-streaming returns Anthropic shape', async () => {
    const res = await fetch(`${URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-sonnet',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'say hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.type).toBe('message');
    expect(j.content?.[0]?.type).toBe('text');
  });

  it('/v1/responses two-turn chain', async () => {
    const first = await fetch(`${URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY!}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        input: 'pick a number 1-9',
      }),
    }).then(r => r.json());
    expect(first.id).toMatch(/^rsp_/);
    const second = await fetch(`${URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY!}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        previous_response_id: first.id,
        input: 'now double it',
      }),
    }).then(r => r.json());
    expect(second.previous_response_id).toBe(first.id);
  });
});
