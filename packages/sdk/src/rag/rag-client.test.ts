import { describe, it, expect } from 'vitest';
import { RagClient } from './rag-client';

function fakeWithResponse(response: any) {
  const calls: any[] = [];
  const fc: any = {
    appId: 'app_x',
    request: (method: string, path: string, body: any) => {
      calls.push({ method, path, body });
      return Promise.resolve(response);
    },
  };
  return { fc, calls };
}

describe('RagClient.query normalization', () => {
  it('reads chunks from results[]', async () => {
    const { fc } = fakeWithResponse({ results: [{ id: '1', content: 'a', score: 0.9 }] });
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.error).toBeNull();
    expect(r.data?.chunks.length).toBe(1);
    expect(r.data?.chunks[0]).toMatchObject({ id: '1', content: 'a', score: 0.9 });
  });

  it('reads chunks from hits[] with text→content fallback', async () => {
    const { fc } = fakeWithResponse({ hits: [{ id: '1', text: 'a', score: 0.9 }] });
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.data?.chunks[0]).toMatchObject({ id: '1', content: 'a', score: 0.9 });
  });

  it('reads chunks from documents[]', async () => {
    const { fc } = fakeWithResponse({ documents: [{ id: '1', content: 'a' }] });
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.data?.chunks.length).toBe(1);
  });

  it('reads answer from answer key', async () => {
    const { fc } = fakeWithResponse({ results: [], answer: 'A' });
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.data?.answer).toBe('A');
  });

  it('reads answer from synthesis key', async () => {
    const { fc } = fakeWithResponse({ results: [], synthesis: 'A' });
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.data?.answer).toBe('A');
  });

  it('handles empty response (no chunks key)', async () => {
    const { fc } = fakeWithResponse({});
    const r = await new RagClient(fc).query('mycoll', { query: 'q' });
    expect(r.data?.chunks).toEqual([]);
    expect(r.data?.answer).toBeUndefined();
  });

  it('forwards request body fields', async () => {
    const { fc, calls } = fakeWithResponse({ results: [] });
    await new RagClient(fc).query('mycoll', { query: 'q', topK: 5, threshold: 0.5, synthesize: true, model: 'm', filter: { x: 1 } });
    expect(calls[0].body).toEqual({
      query: 'q', topK: 5, threshold: 0.5, synthesize: true, model: 'm', filter: { x: 1 },
    });
  });
});
