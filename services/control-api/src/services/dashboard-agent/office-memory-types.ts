/** Optional server integration. No Office storage or authorization lives here. */
export interface OfficeMemoryTurnScope {
  organizationId: string; userId: string; model: string; autonomous: boolean; readOnly: boolean;
  /** Foreground owner message only; autonomous/skill prompts are not owner customization. */
  customizationMessage?: string;
}
export type OfficeMemoryToolAdapter = (name: string, args: unknown) => { name: string; args: unknown };
export interface OfficeMemoryTurnContext { text: string; tools: OfficeMemoryToolAdapter; }
export type OfficeMemoryContextProvider = (scope: OfficeMemoryTurnScope) => Promise<OfficeMemoryTurnContext>;
let provider: OfficeMemoryContextProvider | undefined;
let rewriteRoutine: ((instructions: string) => string) | undefined;
export function setOfficeMemoryContextProvider(next?: OfficeMemoryContextProvider, rewrite?: (instructions: string) => string): void {
  provider = next; rewriteRoutine = rewrite;
}
export function isOfficeMemoryContextConfigured(): boolean { return !!provider; }
export async function resolveOfficeMemoryContext(scope: OfficeMemoryTurnScope): Promise<OfficeMemoryTurnContext | null> {
  return provider ? provider(scope) : null;
}
export function rewriteOfficeRoutineInstructions(instructions: string): string { return rewriteRoutine?.(instructions) ?? instructions; }

export interface OfficeMemoryErrorPayload { code: string; message: string; required?: string[] }

const memoryErrorMessages: Record<string, string> = {
  agent_memory_verification_required: 'record_agent_memory needs payload.verification.evidence (1-20 typed evidence references) when the agent records a finding. Add evidence references and retry.',
  agent_memory_capture_disabled: 'Agent memory capture is disabled for this organization.',
  agent_memory_read_only: 'This Office test turn cannot write agent memory.',
  agent_memory_retrieval_disabled: 'Agent memory retrieval is disabled for this organization.',
  agent_memory_scope_mismatch: 'The memory request targeted a different organization.',
  explicit_memory_kind_required: 'Name the memory kind: agent_memories, or decisions/commitments/learnings/source_artifacts.',
  agent_memory_match_unsupported: "Agent memory supports only match='and'.",
  agent_memory_query_invalid: 'The memory query must be a string.',
  office_test_read_only: 'This Office test turn cannot change data.',
  proposal_preparation_mismatch: 'The reviewed operation no longer matches the prepared proposal.',
};

/** Stable, request-free copy for a tool result the model can act on. */
export function officeMemoryErrorPayload(code: string): OfficeMemoryErrorPayload {
  return {
    code,
    message: memoryErrorMessages[code] ?? 'The memory request was rejected.',
    ...(code === 'agent_memory_verification_required' ? { required: ['payload.verification.evidence'] } : {}),
  };
}
