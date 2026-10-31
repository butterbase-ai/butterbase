import type { OfficeActivityStep, OfficeConversationActivity } from '@butterbase/shared';

const MAX_BYTES = 65536;
const MAX_DEPTH = 7;
export const OFFICE_ACTIVITY_HISTORY_MAX_GROUPS = 100;
export const OFFICE_ACTIVITY_HISTORY_MAX_CALLS = 128;
type Obj = Record<string, any>;
const object = (value: unknown): Obj | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
const slug = (value: unknown, max = 128): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : undefined;
const labels: Record<string, string> = {
  search_agent_memories: 'Searching organization memories', list_agent_memories: 'Checking organization memories',
  get_agent_memory: 'Reading organization memory', record_agent_memory: 'Recording organization memory',
  amend_agent_memory: 'Updating organization memory', archive_agent_memory: 'Archiving organization memory',
  search_memory: 'Searching organization records', list_memory: 'Checking organization records',
};
const writes = new Set(['record_agent_memory', 'amend_agent_memory', 'archive_agent_memory']);
const rejectedCodes = new Set([
  'agent_memory_request_invalid', 'explicit_memory_kind_required', 'agent_memory_match_unsupported',
  'agent_memory_query_invalid', 'agent_memory_scope_mismatch', 'office_test_read_only',
  'agent_memory_retrieval_disabled', 'agent_memory_read_only', 'agent_memory_capture_disabled',
  'agent_memory_verification_required', 'proposal_preparation_mismatch', 'proposal_invalid',
  'proposal_unavailable', 'proposal_review_unavailable', 'deploy_tree_unavailable',
  'working_notes_scope_invalid', 'working_notes_unavailable', 'read_only_test',
]);
// Non-enumerable observation metadata never changes JSON event schemas.
const canonicalCallId = Symbol('officeActivityCallId');
export function withOfficeActivityCallId<T extends object>(event: T, callId: string): T {
  Object.defineProperty(event, canonicalCallId, { value: callId, enumerable: false });
  return event;
}

/** Check resource limits without serializing cycles or traversing unbounded JSON. */
function bounded(value: unknown): boolean {
  let bytes = 0; let nodes = 0;
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 2048 || depth > MAX_DEPTH) return false;
    if (typeof v === 'string') { bytes += Buffer.byteLength(v, 'utf8'); return bytes <= MAX_BYTES; }
    if (v === null || ['number','boolean','undefined'].includes(typeof v)) { bytes += 8; return bytes <= MAX_BYTES; }
    if (typeof v !== 'object' || active.has(v)) return false;
    active.add(v);
    const keys = Object.keys(v); if (keys.length > 512) return false;
    for (const key of keys) { bytes += Buffer.byteLength(key, 'utf8') + 4; if (bytes > MAX_BYTES || !visit((v as Obj)[key], depth + 1)) return false; }
    active.delete(v); return true;
  };
  try { return visit(value, 0); } catch { return false; }
}
/** Only unwrap actual runtime/MCP envelope fields; never copy arbitrary keys. */
function envelopes(value: unknown): Obj[] | null {
  const found: Obj[] = [];
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || !bounded(v)) return false;
    if (typeof v === 'string') { try { return walk(JSON.parse(v), depth + 1); } catch { return false; } }
    const row = object(v); if (!row) return false;
    found.push(row);
    if (row.result !== undefined && row.result !== null && !walk(row.result, depth + 1)) return false;
    if (row.structuredContent !== undefined && !walk(row.structuredContent, depth + 1)) return false;
    if (Array.isArray(row.content)) {
      for (const part of row.content) if (part?.type === 'text' && typeof part.text === 'string' && !walk(part.text, depth + 1)) return false;
    }
    return true;
  };
  return walk(value, 0) ? found : null;
}
function time(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function createOfficeActivityProjector({ now = () => new Date() }: { now?: () => Date } = {}) {
  const steps = new Map<string, OfficeActivityStep>();
  const finished = new Set<string>();
  const capabilities = new Map<string, string | undefined>();
  return { observe(input: unknown): OfficeActivityStep | null {
    const event = object(input); if (!event) return null;
    const timestamp = event.timestamp === null ? null : time(event.timestamp ?? now());
    if (event.type === 'tool_call') {
      const id = slug(event.id, 256); if (!id || steps.has(id) || steps.size >= 512) return null;
      const name = slug(event.name) ?? 'unknown_tool';
      const args = object(event.args);
      const trusted = ['manage_substrate', 'manage_office'].includes(name);
      const action = trusted ? slug(args?.action, 100) : undefined;
      const capability = action === 'propose' ? slug(args?.capability, 100) : action;
      const step: OfficeActivityStep = { id, tool_name: name, ...(action ? { action } : {}),
        label: labels[capability ?? ''] ?? 'Running tool', status: 'running', summary: null,
        started_at: timestamp, finished_at: null, duration_ms: null,
        details: [{ label: 'Tool', value: name }, ...(action ? [{ label: 'Action', value: action }] : [])] };
      steps.set(id, step);
      // Keep capability privately, never submitted payloads.
      capabilities.set(id, capability);
      return structuredClone(step);
    }
    if (event.type === 'approval_required') {
      // The loop emits this before execution and may not emit a tool_call.
      const callId = slug((event as any)[canonicalCallId], 256);
      const existing = callId ? steps.get(callId) : [...steps.values()].reverse().find(s => s.tool_name === event.tool_name && s.status === 'running');
      if (existing) { existing.status = 'awaiting_approval'; existing.summary = 'Awaiting approval'; return structuredClone(existing); }
      const step = this.observe({ type: 'tool_call', id: callId ?? `approval:${slug(event.approval_id, 240) ?? 'unknown'}`, name: event.tool_name, args: event.args, timestamp: event.timestamp ?? timestamp });
      if (!step) return null;
      const stored = steps.get(step.id)!; stored.status = 'awaiting_approval'; stored.summary = 'Awaiting approval'; return structuredClone(stored);
    }
    if (['done', 'error', 'blocked'].includes(event.type)) {
      // The loop dispatches tools sequentially. A terminal observation without
      // a result cannot establish completion or a tool execution failure.
      const unfinished = [...steps.values()].reverse().find(s => s.status === 'running');
      if (!unfinished) return null;
      unfinished.status = event.type === 'blocked' && event.reason === 'execution_interrupted' ? 'interrupted' : 'unknown';
      unfinished.summary = unfinished.status === 'interrupted' ? 'Execution interrupted' : 'Completion was not observed';
      finished.add(unfinished.id);
      return structuredClone(unfinished);
    }
    if (event.type !== 'tool_result' || !slug(event.id, 256) || finished.has(event.id)) return null;
    const previous = steps.get(event.id); if (!previous) return null;
    finished.add(event.id);
    const step = { ...previous, details: [...previous.details], finished_at: timestamp,
      duration_ms: previous.started_at && timestamp ? Math.max(0, Date.parse(timestamp) - Date.parse(previous.started_at)) : null };
    const rows = envelopes(event.result);
    const failed = event.error !== undefined || rows?.some(r => r.isError === true || r.ok === false || r.error != null || r.status === 'failed' || rejectedCodes.has(r.code) || r.verdict?.result === 'blocked');
    const denied = rows?.some(r => ['rejected','denied'].includes(r.status) || (r.ok === false && typeof r.error === 'string' && r.error.startsWith('User denied.')));
    const pending = rows?.some(r => r.requires_approval === true || (r.code === 'proposal_incomplete' && r.parkedProposal?.actionId) || (r.code === 'already_pending' && r.approval_id) || r.confirmation_id || r.decision || ['proposed','pending','awaiting_approval','requires_confirmation'].includes(r.status));
    const codeReceipt = rows?.some(r => typeof r.code === 'string');
    const capability = capabilities.get(previous.id);
    const write = writes.has(capability ?? '') || previous.action === 'propose' || previous.action === 'approve';
    const automaticVerdicts = ['auto_approved', 'auto_approved_yolo', 'auto_approved_user_override'];
    const confirmed = rows?.some(r => r.executed === true || r.status === 'executed' ||
      (r.requires_approval === false && automaticVerdicts.includes(r.verdict?.result)) ||
      // readOfficeMemoryResult returns a committed ledger result, rather than
      // proposeAction's status/requires_approval fields. A verdict alone is insufficient.
      (previous.tool_name === 'manage_office' && writes.has(capability ?? '') &&
        slug(r.action_id, 256) && automaticVerdicts.includes(r.verdict?.result) && slug(r.result?.memory_id, 256)));
    step.status = denied ? 'denied' : failed ? 'failed' : pending ? 'awaiting_approval' : !rows || codeReceipt || (write && !confirmed) ? 'unknown' : 'completed';
    step.summary = { failed: 'Tool reported an error', denied: 'Action denied', awaiting_approval: 'Awaiting approval', unknown: 'Outcome unavailable', completed: 'Tool completed', running: '', interrupted: '' }[step.status];
    if (step.status === 'completed' && previous.action === 'search_agent_memories' && rows?.some(r => Array.isArray(r.items) && r.items.length === 0)) step.summary = 'No matching memories found';
    if (step.status === 'completed' && writes.has(capability ?? '')) {
      const record = rows?.find(r => slug(r.memory_id, 256));
      if (record) { step.result = { kind: 'agent_memory', id: record.memory_id,
        ...(Number.isSafeInteger(record.revision) && record.revision > 0 ? { revision: record.revision } : {}) }; step.summary = capability === 'archive_agent_memory' ? 'Memory archived' : 'Memory saved'; }
    }
    steps.set(step.id, step); return structuredClone(step);
  } };
}

/** Paired transcript rows are already owner/org scoped by the caller. */
export function projectOfficeConversationActivity(messages: ReadonlyArray<{
  id: string; role: string; createdAt?: Date | string | null; toolCallId?: string | null;
  toolName?: string | null; toolArgs?: unknown; toolResult?: unknown; pendingApprovalId?: string | null;
}>): OfficeConversationActivity[] {
  const groups: OfficeConversationActivity[] = [];
  let group: OfficeConversationActivity | undefined;
  let projector = createOfficeActivityProjector();
  const owners = new Map<string, { group: OfficeConversationActivity; projector: ReturnType<typeof createOfficeActivityProjector> }>();
  const put = (target: OfficeConversationActivity, step: OfficeActivityStep | null) => {
    if (!step) return; const index = target.steps.findIndex(s => s.id === step.id);
    if (index < 0) target.steps.push(step); else target.steps[index] = step;
  };
  let start = messages.length; let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      if (++userCount > OFFICE_ACTIVITY_HISTORY_MAX_GROUPS) break;
      start = i;
    }
  }
  for (const message of messages.slice(start)) {
    if (message.role === 'user') { group = { user_message_id: message.id, steps: [] }; groups.push(group); projector = createOfficeActivityProjector(); }
    if (!group || !message.toolCallId) continue;
    if (message.role === 'assistant' && message.toolName) {
      if (!owners.has(message.toolCallId) && owners.size >= OFFICE_ACTIVITY_HISTORY_MAX_CALLS) continue;
      owners.set(message.toolCallId, { group, projector });
      put(group, projector.observe({ type: 'tool_call', id: message.toolCallId, name: message.toolName, args: message.toolArgs, timestamp: message.createdAt ?? null }));
      if (message.pendingApprovalId) put(group, projector.observe({ type: 'approval_required', approval_id: message.pendingApprovalId, tool_name: message.toolName, timestamp: message.createdAt ?? null }));
    } else if (message.role === 'tool') {
      const owner = owners.get(message.toolCallId);
      if (owner) put(owner.group, owner.projector.observe({ type: 'tool_result', id: message.toolCallId, result: message.toolResult, timestamp: message.createdAt ?? null }));
    }
  }
  for (const g of groups) for (const s of g.steps) if (s.status === 'running') { s.status = 'unknown'; s.summary = 'Completion was not observed'; }
  return groups;
}
