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
