export type Role = 'owner' | 'admin' | 'member';
export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
export type EntityType = 'company' | 'person' | 'deal' | 'note' | 'meeting';
export type MeetingResponse = 'accepted' | 'declined' | 'tentative' | 'pending';

export interface Workspace { id: string; name: string; slug: string; owner_user_id: string; created_at: string; updated_at: string }
export interface Membership { id: string; workspace_id: string; user_id: string; role: Role; created_at: string }
export interface Company { id: string; workspace_id: string; name: string; domain: string | null; logo_object_id: string | null; industry: string | null; employee_count: number | null; location: string | null; description: string | null; linkedin_url: string | null; enrichment_status: string | null; enriched_at: string | null; ai_summary: string | null; ai_summary_at: string | null; substrate_entity_id: string | null; created_by: string; created_at: string; updated_at: string }
export interface Person { id: string; workspace_id: string; company_id: string | null; first_name: string | null; last_name: string | null; email: string | null; email_status: string | null; phone: string | null; title: string | null; avatar_object_id: string | null; linkedin_url: string | null; enrichment_status: string | null; enriched_at: string | null; substrate_entity_id: string | null; is_role_account: boolean; created_by: string; created_at: string; updated_at: string }

export interface SubstrateEntitySummary {
  id: string;
  type: string;
  display_name: string | null;
  attrs?: Record<string, unknown> | null;
}
export interface Deal { id: string; workspace_id: string; name: string; company_id: string | null; primary_person_id: string | null; stage: DealStage; amount_cents: number | null; currency: string; close_date: string | null; owner_user_id: string; created_by: string; created_at: string; updated_at: string }
export interface Note { id: string; workspace_id: string; entity_type: EntityType; entity_id: string; body: string; created_by: string; created_at: string; updated_at: string }
export interface Meeting { id: string; workspace_id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; notes: string | null; company_id: string | null; deal_id: string | null; created_by: string; created_at: string; updated_at: string; ai_summary?: string | null; ai_summary_at?: string | null; ai_action_items?: Array<{ text: string }> | null; ai_briefing?: string | null; ai_briefing_at?: string | null }
export interface MeetingAttendee { id: string; workspace_id: string; meeting_id: string; person_id: string | null; external_email: string | null; response: MeetingResponse; created_at: string }
export interface Activity { id: string; workspace_id: string; actor_user_id: string; kind: string; entity_type: EntityType; entity_id: string; payload: Record<string, unknown> | null; created_at: string }
export interface Attachment { id: string; workspace_id: string; entity_type: EntityType; entity_id: string; object_id: string; filename: string; content_type: string | null; size_bytes: number | null; uploaded_by: string; created_at: string }

export type AgentThreadMode = 'onboarding' | 'copilot';
export type AgentThreadStatus = 'active' | 'archived';
export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system_event';
export type AgentProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AgentThread { id: string; workspace_id: string; user_id: string; title: string | null; mode: AgentThreadMode; status: AgentThreadStatus; last_message_at: string; created_at: string; updated_at: string }
export interface AgentMessage { id: string; thread_id: string; workspace_id: string; role: AgentMessageRole; content: string | null; tool_calls: unknown | null; tool_results: { tool_call_id: string; name?: string; args?: unknown; outcome?: { ok: boolean; result?: unknown; summary?: string; error?: string } } | null; ui_event: { kind: string; payload: any } | null; token_usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; created_at: string }
export interface AgentProposal { id: string; thread_id: string; workspace_id: string; proposed_by: string; tool_name: string; payload: Record<string, any>; rationale: string | null; status: AgentProposalStatus; resolution: any | null; resolved_at: string | null; expires_at: string; created_at: string }

export type AgentSseEvent =
  | { event: 'thread'; data: { thread_id: string; mode: AgentThreadMode } }
  | { event: 'user_message_id'; data: { id: string } }
  | { event: 'assistant_start'; data: { message_id: string } }
  | { event: 'assistant_delta'; data: { text: string } }
  | { event: 'tool_call_start'; data: { tool_call_id: string; name: string; args: any } }
  | { event: 'tool_call_done'; data: { tool_call_id: string; ok: boolean; summary?: string; error?: string } }
  | { event: 'ui_event'; data: { kind: string; payload: any } }
  | { event: 'proposal_created'; data: { proposal_id: string; tool_name: string; payload: any; rationale: string | null } }
  | { event: 'assistant_end'; data: { message_id: string; token_usage: any } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: 'done'; data: Record<string, never> };

export type CampaignEntityType = 'people' | 'companies';
export type CampaignListSource = 'manual' | 'ai_search';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type CampaignSendStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface CampaignList {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  entity_type: CampaignEntityType;
  source: CampaignListSource;
  source_spec: Record<string, unknown> | null;
  member_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignListMember {
  id: string;
  workspace_id: string;
  list_id: string;
  entity_type: CampaignEntityType;
  entity_id: string;
  email_snapshot: string | null;
  vars_snapshot: Record<string, unknown> | null;
  added_by: string;
  added_at: string;
}

export interface Campaign {
  id: string;
  workspace_id: string;
  name: string;
  list_id: string;
  subject: string;
  body_template: string;
  from_user_id: string;
  send_via: string;
  daily_limit: number;
  throttle_seconds: number;
  status: CampaignStatus;
  sent_count: number;
  failed_count: number;
  total_count: number;
  started_at: string | null;
  completed_at: string | null;
  last_sent_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ObjectTypeSlug = 'people' | 'companies' | 'deals' | 'meetings';
export type CustomFieldKind = 'text' | 'number' | 'date' | 'url' | 'checkbox' | 'select' | 'multiselect';

export interface SavedView {
  id: string;
  workspace_id: string;
  object_type: ObjectTypeSlug;
  name: string;
  filters: Array<{ field: string; op: string; value?: unknown }>;
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  visible_fields: string[] | null;
  is_default: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomField {
  id: string;
  workspace_id: string;
  object_type: ObjectTypeSlug;
  name: string;
  slug: string;
  kind: CustomFieldKind;
  config: Record<string, unknown> | null;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomFieldValue {
  id: string;
  workspace_id: string;
  field_id: string;
  object_type: ObjectTypeSlug;
  entity_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_json: unknown | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignSend {
  id: string;
  workspace_id: string;
  campaign_id: string;
  entity_type: CampaignEntityType;
  entity_id: string;
  email: string;
  resolved_subject: string | null;
  resolved_body: string | null;
  status: CampaignSendStatus;
  scheduled_for: string;
  sent_at: string | null;
  gmail_message_id: string | null;
  error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}
