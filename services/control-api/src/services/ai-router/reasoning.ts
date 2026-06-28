export type Effort = 'low' | 'medium' | 'high';
export interface Reasoning { enabled: boolean; effort: Effort; budgetTokens: number; }

const LOW_MAX = 8000;
const MEDIUM_MAX = 16000;
const MID = { low: 4000, medium: 12000, high: 24000 } as const;

export function effortFromBudget(budgetTokens: number): Effort {
  if (budgetTokens < LOW_MAX) return 'low';
  if (budgetTokens < MEDIUM_MAX) return 'medium';
  return 'high';
}

export function budgetFromEffort(effort: Effort): number { return MID[effort]; }

export function parseReasoningFromBody(body: Record<string, unknown>): Reasoning | null {
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    return { enabled: true, effort: effortFromBudget(thinking.budget_tokens), budgetTokens: thinking.budget_tokens };
  }
  const effortChat = body.reasoning_effort as Effort | undefined;
  if (effortChat === 'low' || effortChat === 'medium' || effortChat === 'high') {
    return { enabled: true, effort: effortChat, budgetTokens: budgetFromEffort(effortChat) };
  }
  const reasoning = body.reasoning as { effort?: Effort } | undefined;
  if (reasoning?.effort === 'low' || reasoning?.effort === 'medium' || reasoning?.effort === 'high') {
    return { enabled: true, effort: reasoning.effort, budgetTokens: budgetFromEffort(reasoning.effort) };
  }
  return null;
}

export function stripThinkingSuffix(model: string): { model: string; usedSuffix: boolean } {
  if (model.endsWith(':thinking')) return { model: model.slice(0, -':thinking'.length), usedSuffix: true };
  return { model, usedSuffix: false };
}

export function toAnthropicThinking(r: Reasoning) {
  return { type: 'enabled' as const, budget_tokens: r.budgetTokens };
}
export function toReasoningEffort(r: Reasoning): Effort { return r.effort; }

export function extractReasoningTokens(usage: Record<string, unknown>): number {
  const details = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined;
  return typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : 0;
}
