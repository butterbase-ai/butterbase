import type {
  OfficeClientOptions, OfficeAction, OfficeRequestOptions, OfficeWriteOptions, OfficePageOptions, OfficePage,
  OfficeStatus, ConfirmationReceipt, DecisionRef, OfficeDecision, OfficeDecisionContext, OfficeConversation, OfficeConversationDetail,
  OfficeTurn, OfficePublicEvent, OfficeMemoryRecord, OfficeMemoryResult, OfficeSourceArtifact, OfficePrinciple,
  OfficeRecordDecisionInput, OfficeRecordCommitmentInput, OfficeRecordLearningInput, OfficeRecordPrincipleInput,
  AgentMemorySummary, AgentMemoryRecord, OfficeRecordAgentMemoryInput, OfficeAmendAgentMemoryInput, OfficeArchiveAgentMemoryInput,
  OfficeSkillRecord, OfficeSkillDetail, OfficeSkillVersionRecord, OfficeSkillRunRecord,
  OfficeAmendPrincipleInput, OfficeRetirePrincipleInput,
} from '@butterbase/shared';
import { OfficeTransport, officeError } from './transport.js';
import { OfficeClientError, OfficeStreamError, type OfficeAskOptions, type OfficeAskStreamOptions, type OfficeConfirmationWaitOptions,
  type OfficeDecisionListOptions, type OfficeConversationCreateOptions, type OfficeConversationGetOptions,
  type OfficeMemoryListOptions, type OfficeResponse } from './types.js';
import { readOfficeEvents } from './stream.js';

/** Organization-scoped Office API. Uses platform credentials, with no app/session state. */
export class OfficeClient {
  private readonly transport: OfficeTransport;
  readonly organizationId: string;
  constructor(options: OfficeClientOptions) {
    this.organizationId = options.organizationId; this.transport = new OfficeTransport({ ...options });
  }
  private call<T>(action: OfficeAction, fields: Record<string, unknown> = {}, options?: OfficeRequestOptions): Promise<OfficeResponse<T>> {
    return this.transport.request({ ...fields, action, org_id: this.organizationId }, options?.signal);
  }
  private async write<T>(action: OfficeAction, fields: Record<string, unknown>, options?: OfficeWriteOptions): Promise<OfficeResponse<T>> {
    try {
      const key = options?.idempotencyKey ?? globalThis.crypto.randomUUID();
      const result = await this.call<T>(action, { ...fields, idempotency_key: key }, options);
      return result.error ? { ...result, error: new OfficeClientError(result.error.detail, result.error.status, key) } : result;
    }
    catch { return { data: null, error: officeError('invalid_request', 'A unique idempotency key is required for this write.') }; }
  }
  getStatus(options?: OfficeRequestOptions) { return this.call<OfficeStatus>('status', {}, options); }
  enable(options?: OfficeWriteOptions) { return this.write<ConfirmationReceipt>('enable', {}, options); }
  pause(options?: OfficeWriteOptions) { return this.write<ConfirmationReceipt>('pause', {}, options); }
  resume(options?: OfficeWriteOptions) { return this.write<ConfirmationReceipt>('resume', {}, options); }
  getConfirmation(id: string, options?: OfficeRequestOptions) { return this.call<ConfirmationReceipt>('status', { confirmation_id: id }, options); }
  readonly decisions = {
    list: (options?: OfficeDecisionListOptions) => this.call<OfficePage<OfficeDecision>>('list_decisions', { cursor: options?.cursor, limit: options?.limit, status: options?.status }, options),
    get: (ref: DecisionRef, options?: OfficeRequestOptions) => this.call<OfficeDecision>('get_decision', { decision_id: ref.id, decision_source: ref.source }, options),
    getContext: (ref: DecisionRef, options?: OfficeRequestOptions & { limit?: number }) => this.call<OfficeDecisionContext>('get_decision_context', { decision_id: ref.id, decision_source: ref.source, limit: options?.limit }, options),
    approve: (ref: DecisionRef, options?: OfficeWriteOptions) => this.write<ConfirmationReceipt>('approve', { decision_id: ref.id, decision_source: ref.source }, options),
    deny: (ref: DecisionRef, options: OfficeRequestOptions & { reason: string }) => this.call<OfficeDecision>('deny', { decision_id: ref.id, decision_source: ref.source, reason: options.reason }, options),
  };
  readonly conversations = {
    create: (options?: OfficeConversationCreateOptions) => this.write<OfficeConversation>('create_conversation', { title: options?.title }, options),
    list: (options?: OfficePageOptions) => this.call<OfficePage<OfficeConversation>>('list_conversations', { cursor: options?.cursor, limit: options?.limit }, options),
    get: (id: string, options?: OfficeConversationGetOptions) => this.call<OfficeConversationDetail>('get_conversation', { conversation_id: id, turn_id: options?.turnId, after_sequence: options?.afterSequence, limit: options?.limit }, options),
  };
  ask(message: string, options?: OfficeAskOptions) { return this.write<OfficeTurn>('ask', { message, conversation_id: options?.conversationId, wait_ms: options?.waitMs }, options); }
  readonly agentMemories = {
    list: (options?: OfficePageOptions) => this.call<OfficePage<AgentMemorySummary>>('list_agent_memories', { cursor: options?.cursor, limit: options?.limit }, options),
    search: (query: string, options?: OfficePageOptions) => this.call<OfficePage<AgentMemorySummary>>('search_agent_memories', { cursor: options?.cursor, limit: options?.limit, query }, options),
    get: (id: string, options?: OfficeRequestOptions) => this.call<AgentMemoryRecord>('get_agent_memory', { memory_id: id }, options),
    record: (payload: OfficeRecordAgentMemoryInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('record_agent_memory', { payload }, options),
    amend: (payload: OfficeAmendAgentMemoryInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('amend_agent_memory', { payload }, options),
    archive: (payload: OfficeArchiveAgentMemoryInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('archive_agent_memory', { payload }, options),
  };
  readonly memory = {
    list: (options?: OfficeMemoryListOptions) => this.call<OfficePage<OfficeMemoryRecord>>('list_memory', { cursor: options?.cursor, limit: options?.limit, kind: options?.kind }, options),
    search: (query: string, options?: OfficeRequestOptions & { limit?: number }) => this.call<OfficePage<OfficeMemoryRecord>>('search_memory', { query, limit: options?.limit }, options),
    getSourceArtifact: (id: string, options?: OfficeRequestOptions) => this.call<OfficeSourceArtifact>('get_source_artifact', { source_artifact_id: id }, options),
    recordDecision: (payload: OfficeRecordDecisionInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('record_decision', { payload }, options),
    recordCommitment: (payload: OfficeRecordCommitmentInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('record_commitment', { payload }, options),
    recordLearning: (payload: OfficeRecordLearningInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('record_learning', { payload }, options),
  };
  readonly principles = {
    amend: (payload: OfficeAmendPrincipleInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('amend_principle', { payload }, options),
    retire: (payload: OfficeRetirePrincipleInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('retire_principle', { payload }, options),
    list: (options?: OfficePageOptions) => this.call<OfficePage<OfficePrinciple>>('list_principles', { cursor: options?.cursor, limit: options?.limit }, options),
    get: (id: string, options?: OfficeRequestOptions) => this.call<OfficePrinciple>('get_principle', { principle_id: id }, options),
    record: (payload: OfficeRecordPrincipleInput, options?: OfficeWriteOptions) => this.write<OfficeMemoryResult>('record_principle', { payload }, options),
  };
  readonly skills = {
    list: (options?: OfficePageOptions) => this.call<OfficePage<OfficeSkillRecord>>('list_skills', { cursor: options?.cursor, limit: options?.limit }, options),
    get: (id: string, options?: OfficeRequestOptions) => this.call<OfficeSkillDetail>('get_skill', { skill_id: id }, options),
    versions: (id: string, options?: OfficePageOptions) => this.call<OfficePage<OfficeSkillVersionRecord>>('list_skill_versions', { skill_id: id, cursor: options?.cursor, limit: options?.limit }, options),
    runs: (id: string, options?: OfficePageOptions) => this.call<OfficePage<OfficeSkillRunRecord>>('list_skill_runs', { skill_id: id, cursor: options?.cursor, limit: options?.limit }, options),
    draft: (message: string, input: { skillId?: string } = {}, options?: OfficeWriteOptions) => this.write<OfficeTurn>('draft_skill', { message, skill_id: input.skillId }, options),
    test: (id: string, version: number, options?: OfficeWriteOptions) => this.write<OfficeSkillRunRecord>('test_skill', { skill_id: id, version }, options),
    reject: (id: string, version: number, reason: string, options?: OfficeWriteOptions) => this.write<{ status: 'rejected' }>('reject_skill', { skill_id: id, version, reason }, options),
    approve: (id: string, version: number, options?: OfficeWriteOptions) => this.write<ConfirmationReceipt>('approve_skill', { skill_id: id, version }, options),
    setEnabled: (id: string, enabled: boolean, options?: OfficeWriteOptions) => this.write<ConfirmationReceipt>('set_skill_enabled', { skill_id: id, enabled }, options),
    rollback: (id: string, version: number, options?: OfficeWriteOptions) => this.write<ConfirmationReceipt>('rollback_skill', { skill_id: id, version }, options),
    run: (id: string, options?: OfficeWriteOptions) => this.write<ConfirmationReceipt>('run_skill', { skill_id: id }, options),
  };
  /** Timeout/abort ends only observation. On timeout data retains the last receipt. */
  async waitForConfirmation(id: string, options: OfficeConfirmationWaitOptions = {}): Promise<OfficeResponse<ConfirmationReceipt>> {
    const timeout = options.timeoutMs ?? 120000, interval = options.pollIntervalMs ?? 1000;
    if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(interval) || interval <= 0) return { data: null, error: officeError('invalid_request', 'Use a nonnegative timeout and a positive polling interval.') };
    const observer = new AbortController(); let timedOut = false, last: ConfirmationReceipt | null = null;
    const abort = () => observer.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; observer.abort(); }, timeout);
    try {
      while (!observer.signal.aborted) {
        const result = await this.getConfirmation(id, { signal: observer.signal });
        if (result.error) {
          if (observer.signal.aborted) break;
          return { data: last, error: result.error };
        }
        last = result.data;
        if (last && last.state !== 'awaiting_confirmation' && last.state !== 'executing') return { data: last, error: null };
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(poll); observer.signal.removeEventListener('abort', done); resolve(); };
          const poll = setTimeout(done, interval); observer.signal.addEventListener('abort', done, { once: true });
          if (observer.signal.aborted) done();
        });
      }
      return { data: last, error: officeError(timedOut ? 'observation_timeout' : 'aborted', timedOut ? 'Stopped waiting. Inspect this confirmation before taking further action.' : 'Observation was cancelled.') };
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
  /** Supply conversationId+turnId to observe an existing Ask without submitting. */
  async *askStream(message: string, options: OfficeAskStreamOptions = {}): AsyncGenerator<OfficePublicEvent> {
    let conversationId = options.conversationId, turnId = options.turnId;
    const after = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 || (turnId && !conversationId) || (!turnId && after > 0)) throw officeError('invalid_request', 'Replay requires exact conversation and turn IDs and a nonnegative sequence.');
    if (!turnId) {
      const admitted = await this.ask(message, { ...options, waitMs: 0 });
      if (admitted.error) throw admitted.error;
      if (!admitted.data) throw officeError('protocol_error', 'Office did not return an admitted turn.');
      conversationId = admitted.data.conversation_id; turnId = admitted.data.turn_id;
    }
    if (!conversationId) throw officeError('invalid_request', 'conversationId is required.');
    try {
      const response = await this.transport.open({ organizationId: this.organizationId, method: 'GET',
        path: `/v1/me/office/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/events?after_sequence=${after}` }, options.signal, true);
      yield* readOfficeEvents(response, conversationId, turnId, after, options.signal);
    } catch (error) {
      if (error instanceof OfficeStreamError) throw error;
      throw new OfficeStreamError(error instanceof OfficeClientError ? error : officeError('connection_error', 'Office event observation ended.'), conversationId, turnId, after);
    }
  }
}
