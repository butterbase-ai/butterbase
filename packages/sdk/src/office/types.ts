import type { OfficeError, OfficeErrorCode, OfficeRequestOptions, OfficeWriteOptions, OfficePageOptions } from '@butterbase/shared';
export type {
  AgentMemorySummary, AgentMemoryRecord, OfficeRecordAgentMemoryInput, OfficeAmendAgentMemoryInput, OfficeArchiveAgentMemoryInput,
  OfficeClientOptions, OfficeRequestOptions, OfficeWriteOptions, OfficePageOptions, OfficePage,
  OfficeStatus, ConfirmationReceipt, OfficeCommandReview, DecisionRef, OfficeDecision, OfficeDecisionContext,
  OfficeConversation, OfficeConversationDetail, OfficeTurn, OfficePublicEvent, OfficeError, OfficeErrorCode,
  OfficeMemoryResult, OfficeMemoryRecord, OfficeSourceArtifact, OfficePrinciple,
  OfficeRecordDecisionInput, OfficeRecordCommitmentInput, OfficeRecordLearningInput, OfficeRecordPrincipleInput,
} from '@butterbase/shared';

export class OfficeClientError extends Error {
  readonly code: OfficeErrorCode;
  readonly decision?: OfficeError['decision'];
  readonly history?: OfficeError['history'];
  constructor(readonly detail: OfficeError, readonly status?: number, readonly idempotencyKey?: string) {
    super(detail.message); this.name = 'OfficeClientError'; this.code = detail.code;
    this.decision = detail.decision; this.history = detail.history;
  }
}
export class OfficeStreamError extends OfficeClientError {
  constructor(error: OfficeClientError, readonly conversationId: string, readonly turnId: string, readonly lastSequence: number) {
    super(error.detail, error.status, error.idempotencyKey); this.name = 'OfficeStreamError';
  }
}
export interface OfficeResponse<T> { data: T | null; error: OfficeClientError | null; }
export interface OfficeAskOptions extends OfficeWriteOptions { conversationId?: string; waitMs?: number; }
export interface OfficeAskStreamOptions extends OfficeAskOptions { turnId?: string; afterSequence?: number; }
export interface OfficeConfirmationWaitOptions extends OfficeRequestOptions { timeoutMs?: number; pollIntervalMs?: number; }
export interface OfficeDecisionListOptions extends OfficePageOptions { status?: 'pending' | 'resolved' | 'all'; }
export interface OfficeConversationCreateOptions extends OfficeWriteOptions { title?: string; }
export interface OfficeConversationGetOptions extends OfficeRequestOptions { turnId?: string; afterSequence?: number; limit?: number; }
export interface OfficeMemoryListOptions extends OfficePageOptions { kind?: 'decision' | 'commitment' | 'learning'; }
