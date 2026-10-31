import { officeActionSchema } from './office.js';

export interface OfficeHttpRequest { organizationId: string; method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; }
const BASE = '/v1/me/office';
/** Public facade descriptor, kept in parity with the cloud MCP adapter. */
export function officeHttpRequest(input: unknown): OfficeHttpRequest {
  const r = officeActionSchema.parse(input);
  const result: OfficeHttpRequest = { organizationId: r.org_id, method: 'GET', path: BASE };
  function get(path: string, query: Record<string, unknown> = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    result.path = `${BASE}${path}${params.size ? `?${params}` : ''}`; return result;
  }
  function post(path: string, body: Record<string, unknown>) { return { ...result, method: 'POST' as const, path: `${BASE}${path}`, body }; }
  switch (r.action) {
    case 'get_office_settings': return get('/settings');
    case 'update_office_settings': return post('/confirmations', { action: 'settings_update', interval_minutes: r.interval_minutes, expected_revision: r.expected_revision, idempotency_key: r.idempotency_key });
    case 'status': return get(r.confirmation_id ? `/confirmations/${encodeURIComponent(r.confirmation_id)}` : '');
    case 'enable': case 'pause': case 'resume': return post('/confirmations', { action: r.action, idempotency_key: r.idempotency_key });
    case 'approve': return post('/confirmations', { action: r.action, decision: { source: r.decision_source, id: r.decision_id }, idempotency_key: r.idempotency_key });
    case 'list_decisions': return get('/decisions', { cursor: r.cursor, limit: r.limit, status: r.status });
    case 'get_decision': return get(`/decisions/${r.decision_source}/${encodeURIComponent(r.decision_id)}`);
    case 'get_decision_context': return get(`/decisions/${r.decision_source}/${encodeURIComponent(r.decision_id)}/context`, { limit: r.limit });
    case 'deny': return post(`/decisions/${r.decision_source}/${encodeURIComponent(r.decision_id)}/deny`, { reason: r.reason });
    case 'create_conversation': return post('/conversations', { ...(r.title ? { title: r.title } : {}), idempotency_key: r.idempotency_key });
    case 'list_conversations': return get('/conversations', { cursor: r.cursor, limit: r.limit });
    case 'get_conversation': return get(`/conversations/${encodeURIComponent(r.conversation_id)}`, { turn_id: r.turn_id, after_sequence: r.after_sequence, limit: r.limit });
    case 'ask': return post('/ask', { message: r.message, ...(r.conversation_id ? { conversation_id: r.conversation_id } : {}), idempotency_key: r.idempotency_key, wait_ms: r.wait_ms });
    case 'list_agent_memories': return get('/agent-memories', { cursor: r.cursor, limit: r.limit });
    case 'search_agent_memories': return get('/agent-memories/search', { cursor: r.cursor, limit: r.limit, query: r.query });
    case 'get_agent_memory': return get(`/agent-memories/${encodeURIComponent(r.memory_id)}`);
    case 'record_agent_memory': case 'amend_agent_memory': case 'archive_agent_memory':
      return post(`/agent-memories/${r.action.split('_')[0]}`, { payload: r.payload, idempotency_key: r.idempotency_key });
    case 'list_memory': return get('/memory', { cursor: r.cursor, limit: r.limit, kind: r.kind });
    case 'list_skills': return get('/skills', { cursor: r.cursor, limit: r.limit });
    case 'get_skill': return get(`/skills/${r.skill_id}`);
    case 'list_skill_versions': return get(`/skills/${r.skill_id}/versions`, { cursor: r.cursor, limit: r.limit });
    case 'list_skill_runs': return get(`/skills/${r.skill_id}/runs`, { cursor: r.cursor, limit: r.limit });
    case 'draft_skill': return post('/skills/draft', { message: r.message, ...(r.skill_id ? { skill_id: r.skill_id } : {}), idempotency_key: r.idempotency_key });
    case 'test_skill': return post(`/skills/${r.skill_id}/versions/${r.version}/test`, { idempotency_key: r.idempotency_key });
    case 'reject_skill': return post(`/skills/${r.skill_id}/versions/${r.version}/reject`, { reason: r.reason, idempotency_key: r.idempotency_key });
    case 'approve_skill': case 'rollback_skill': return post('/confirmations', { action: r.action === 'approve_skill' ? 'skill_approve' : 'skill_rollback', skill_id: r.skill_id, version: r.version, idempotency_key: r.idempotency_key });
    case 'set_skill_enabled': return post('/confirmations', { action: 'skill_set_enabled', skill_id: r.skill_id, enabled: r.enabled, idempotency_key: r.idempotency_key });
    case 'run_skill': return post('/confirmations', { action: 'skill_run_now', skill_id: r.skill_id, idempotency_key: r.idempotency_key });
    case 'search_memory': return get('/memory/search', { query: r.query, limit: r.limit });
    case 'get_source_artifact': return get(`/memory/sources/${encodeURIComponent(r.source_artifact_id)}`);
    case 'record_decision': case 'record_commitment': case 'record_learning': case 'record_principle': return post(`/memory/${r.action}`, { payload: r.payload, idempotency_key: r.idempotency_key });
    case 'list_principles': return get('/principles', { cursor: r.cursor, limit: r.limit });
    case 'get_principle': return get(`/principles/${encodeURIComponent(r.principle_id)}`);
    case 'amend_principle': case 'retire_principle': return post(`/principles/${r.action.split('_')[0]}`, { payload: r.payload, idempotency_key: r.idempotency_key });
  }
}
