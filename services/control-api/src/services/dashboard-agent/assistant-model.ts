/** Fallback for installations without a configured Assistant/Office default. */
export const DEFAULT_ASSISTANT_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * Explicit request > saved conversation > deployment setting > fallback.
 * Resolve the environment lazily so request schemas and Office clients do not
 * freeze the default at import time. OPERATOR_MODEL controls background wakes
 * separately. Blank values are absent; model IDs are routed by the catalog.
 */
export function resolveAssistantModel(requested?: string | null, conversationModel?: string | null): string {
  return requested?.trim() || conversationModel?.trim() ||
    process.env.DASHBOARD_ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
}
