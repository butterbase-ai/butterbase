export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface Membership {
  id: string;
  user_id: string;
  role: Role;
  invited_email?: string | null;
  added_by?: string | null;
  added_at: string;
}

export type TicketStatus =
  | 'open'
  | 'pending_agent'
  | 'awaiting_approval'
  | 'awaiting_customer'
  | 'escalated'
  | 'resolved'
  | 'closed';

export interface SupportTicket {
  id: string;
  channel: string;
  customer_substrate_id?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_external_id?: string | null;
  visitor_token?: string | null;
  identity_verified?: boolean;
  subject?: string | null;
  status: TicketStatus;
  assigned_to?: string | null;
  issue_type?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  opened_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  pending_proposal_count?: number;
}

export type MessageRole = 'customer' | 'agent_draft' | 'founder' | 'system' | 'assistant';

export interface SupportMessage {
  id: string;
  ticket_id: string;
  role: MessageRole;
  body: string | null;
  drafted_by_thread_id?: string | null;
  drafted_by_user_id?: string | null;
  parent_message_id?: string | null;
  token_usage?: Record<string, unknown> | null;
  created_at: string;
}

export interface Diagnosis {
  id: string;
  ticket_id: string;
  summary: string | null;
  evidence?: Array<{ source: string; excerpt: string; score?: number }> | null;
  confidence: 'high' | 'med' | 'low' | string;
  produced_by_thread_id?: string | null;
  produced_at: string;
  superseded_at?: string | null;
}

export interface AgentProposal {
  id: string;
  thread_id: string;
  ticket_id: string;
  capability: string;
  payload: Record<string, unknown>;
  rationale?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | string;
  policy_verdict?: string | null;
  substrate_action_id?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface Escalation {
  id: string;
  ticket_id: string;
  target_id?: string | null;
  reason?: string | null;
  context_snapshot?: Record<string, unknown> | null;
  substrate_action_id?: string | null;
  idempotency_key?: string | null;
  status: 'queued' | 'sent' | 'failed' | 'acknowledged' | string;
  error?: string | null;
  sent_at?: string | null;
  created_at: string;
}

export interface DocsSource {
  id: string;
  url?: string | null;
  source_kind: 'web' | 'file' | 'text' | string;
  display_name?: string | null;
  rag_collection_id?: string | null;
  last_crawl_at?: string | null;
  last_crawl_status?: 'pending' | 'processing' | 'ready' | 'failed' | string | null;
  last_crawl_error?: string | null;
  chunk_count: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EscalationTarget {
  id: string;
  channel: 'slack' | 'email' | 'webhook' | string;
  config: Record<string, unknown>;
  is_default: boolean;
  active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PatternSignal {
  id: string;
  signal_kind: string;
  signal_key: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  sample_ticket_ids?: string[] | null;
  surfaced: boolean;
  surfaced_at?: string | null;
}
