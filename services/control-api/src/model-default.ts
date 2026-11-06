/**
 * The platform-wide default chat model.
 *
 * The 2026-11-03 decision: default to Qwen (the partnership commitment) while
 * keeping an explicit `PLATFORM_DEFAULT_MODEL` override and per-organization
 * settings. `qwen/qwen3.8-flash` is the production build of Qwen3.8-Flash-Next.
 */
export const QWEN_DEFAULT_MODEL = 'qwen/qwen3.8-flash';

export function resolvePlatformDefaultModel(
  env: Record<string, string | undefined>,
): string {
  return env.PLATFORM_DEFAULT_MODEL ?? QWEN_DEFAULT_MODEL;
}
