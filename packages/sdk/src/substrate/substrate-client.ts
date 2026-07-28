import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type {
  SubstrateStreamOptions,
  SubstrateStreamSubscription,
  SubstrateChangeEvent,
} from './types.js';

/** Pure: build the substrate stream WS URL from an API origin + auth opts. */
export function buildSubstrateStreamUrl(
  apiUrl: string,
  opts: { token?: string; ticket?: string },
): string {
  const wsBase = apiUrl.replace(/^http/, 'ws');
  const params = new URLSearchParams();
  if (opts.ticket) params.set('ticket', opts.ticket);
  else if (opts.token) params.set('token', opts.token);
  const qs = params.toString();
  return `${wsBase}/v1/me/substrate/stream${qs ? `?${qs}` : ''}`;
}

const MAX_BACKOFF_MS = 30_000;

export class SubstrateStreamClient {
  private client: ButterbaseClient;
  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  /**
   * Open an org-scoped substrate change stream. Provide either `token`
   * (bb_sub_ / bb_sk_ prefixed) or a pre-minted `ticket`. Reconnects with backoff.
   */
  stream(opts: SubstrateStreamOptions): SubstrateStreamSubscription {
    const apiUrl = (this.client as any).apiUrl as string;
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoffMs = 1000;

    const connect = () => {
      if (stopped) return;
      opts.onStatus?.('connecting');
      const url = buildSubstrateStreamUrl(apiUrl, {
        token: opts.token,
        ticket: opts.ticket,
      });
      ws = new WebSocket(url);
      ws.onopen = () => { backoffMs = 1000; opts.onStatus?.('open'); };
      ws.onmessage = (e) => {
        let frame: unknown;
        try { frame = JSON.parse((e as MessageEvent).data as string); } catch { return; }
        if ((frame as any)?.type === 'hello') return;
        opts.onChange(frame as SubstrateChangeEvent);
      };
      ws.onclose = () => {
        opts.onStatus?.('closed');
        if (stopped) return;
        setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      };
      ws.onerror = () => { /* close handler runs next */ };
    };

    connect();
    return {
      unsubscribe: () => { stopped = true; ws?.close(); },
    };
  }
}
