// packages/sdk/src/ai/meetings-client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MeetingsClient } from './meetings-client.js';

function fakeClient(impl: any) {
  return { appId: 'app_1', request: vi.fn(impl), requestRaw: vi.fn() } as any;
}

describe('MeetingsClient', () => {
  it('start POSTs to /v1/ai/meetings and returns the bot', async () => {
    const client = fakeClient(async () => ({
      id: 'bot_1', status: 'joining', startedAt: null, completedAt: null,
      durationSeconds: null, recordingUrl: null, transcriptUrl: null, metadata: {},
    }));
    const meet = new MeetingsClient(client);
    const { data, error } = await meet.start({ meetingUrl: 'https://meet.google.com/abc' });
    expect(error).toBeNull();
    expect(data?.id).toBe('bot_1');
    expect(client.request).toHaveBeenCalledWith('POST', '/v1/ai/meetings',
      expect.objectContaining({ meetingUrl: 'https://meet.google.com/abc' }));
  });

  it('get GETs /v1/ai/meetings/:id', async () => {
    const client = fakeClient(async () => ({ id: 'bot_1', status: 'done' }));
    const meet = new MeetingsClient(client);
    await meet.get('bot_1');
    expect(client.request).toHaveBeenCalledWith('GET', '/v1/ai/meetings/bot_1');
  });

  it('stop DELETEs /v1/ai/meetings/:id', async () => {
    const client = fakeClient(async () => null);
    const meet = new MeetingsClient(client);
    const out = await meet.stop('bot_1');
    expect(out.error).toBeNull();
    expect(client.request).toHaveBeenCalledWith('DELETE', '/v1/ai/meetings/bot_1');
  });

  it('list builds the query string', async () => {
    const client = fakeClient(async () => ({ bots: [], nextCursor: null }));
    const meet = new MeetingsClient(client);
    await meet.list({ status: 'done', limit: 50, cursor: 'c1' });
    expect(client.request).toHaveBeenCalledWith('GET',
      '/v1/ai/meetings?status=done&limit=50&cursor=c1');
  });

  it('surfaces errors via {data:null, error}', async () => {
    const client = fakeClient(async () => { throw new Error('boom'); });
    const meet = new MeetingsClient(client);
    const { data, error } = await meet.start({ meetingUrl: 'https://meet.google.com/abc' });
    expect(data).toBeNull();
    expect(error?.message).toBe('boom');
  });

  it('estimateCost returns markup-applied USD', async () => {
    const client = fakeClient(async () => ({ usd: 0.075 }));
    const meet = new MeetingsClient(client);
    const { data } = await meet.estimateCost({ durationMinutes: 60 });
    expect(data?.usd).toBe(0.075);
  });
});
