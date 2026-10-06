export interface SubstrateChangeEvent {
  org: string;
  op: 'insert' | 'update' | 'delete';
  tbl: string;
  id: string;
}

export interface SubstrateStreamOptions {
  /** Substrate API key (bb_sub_* / bb_sk_*) for direct/server consumers. */
  token?: string;
  /** Pre-minted single-use wst_ ticket (browser/app on-ramp). */
  ticket?: string;
  onChange: (evt: SubstrateChangeEvent) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
}

export interface SubstrateStreamSubscription {
  unsubscribe: () => void;
}
