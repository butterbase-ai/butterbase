import { describe, it, expect } from 'vitest';
import { buildSubstrateStreamUrl } from './substrate-client.js';
import type { SubstrateChangeEvent } from './types.js';

describe('buildSubstrateStreamUrl', () => {
  it('uses wss, the /v1/me/substrate/stream path, and passes the ticket', () => {
    const url = buildSubstrateStreamUrl('https://api.butterbase.ai', { ticket: 'wst_abc' });
    expect(url).toBe('wss://api.butterbase.ai/v1/me/substrate/stream?ticket=wst_abc');
  });

  it('passes token and org_id when provided', () => {
    const url = buildSubstrateStreamUrl('https://api.butterbase.ai', { token: 'bb_sk_x', orgId: 'org1' });
    expect(url).toBe('wss://api.butterbase.ai/v1/me/substrate/stream?token=bb_sk_x&org_id=org1');
  });

  it('downgrades http origins to ws (local dev)', () => {
    const url = buildSubstrateStreamUrl('http://localhost:4000', { ticket: 'wst_1' });
    expect(url).toBe('ws://localhost:4000/v1/me/substrate/stream?ticket=wst_1');
  });
});

import { SubstrateStreamClient } from './substrate-client.js';

class FakeWS {
  static last: FakeWS;
  onopen?: () => void; onmessage?: (e: any) => void; onclose?: () => void; onerror?: () => void;
  closed = false;
  constructor(public url: string) { FakeWS.last = this; }
  close() { this.closed = true; this.onclose?.(); }
}

describe('SubstrateStreamClient.stream', () => {
  it('parses frames, skips hello, and stops on unsubscribe', () => {
    (globalThis as any).WebSocket = FakeWS as any;
    const client = { apiUrl: 'https://api.butterbase.ai' } as any;
    const got: SubstrateChangeEvent[] = [];
    const sub = new SubstrateStreamClient(client).stream({
      ticket: 'wst_1',
      onChange: (evt) => got.push(evt),
    });
    FakeWS.last.onopen?.();
    FakeWS.last.onmessage?.({ data: JSON.stringify({ type: 'hello', ts: 1 }) });
    FakeWS.last.onmessage?.({ data: JSON.stringify({ org: 'o1', op: 'insert', tbl: 'entities', id: 'e1' }) });
    expect(got).toEqual([{ org: 'o1', op: 'insert', tbl: 'entities', id: 'e1' }]);
    sub.unsubscribe();
    expect(FakeWS.last.closed).toBe(true);
  });
});
