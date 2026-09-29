export const RESERVED_KEY_PREFIX_RE = /^BUTTERBASE_/i;

/**
 * BUTTERBASE_* keys users may set themselves. BUTTERBASE_API_KEY is a
 * convention, not a platform-injected value: the runtime never injects it
 * (deno-runtime/worker-executor.ts platformEnv), and the docs tell users to
 * supply their own bb_sk_* under that name so functions can call the app's
 * API with service-key auth. Every other BUTTERBASE_* name stays reserved.
 */
export const USER_SETTABLE_BUTTERBASE_KEYS: ReadonlySet<string> = new Set(['BUTTERBASE_API_KEY']);

export function validateEnvKeys(
  keys: string[]
): { code: 'reserved_key_prefix'; key: string } | null {
  for (const key of keys) {
    if (RESERVED_KEY_PREFIX_RE.test(key) && !USER_SETTABLE_BUTTERBASE_KEYS.has(key)) {
      return { code: 'reserved_key_prefix', key };
    }
  }
  return null;
}
