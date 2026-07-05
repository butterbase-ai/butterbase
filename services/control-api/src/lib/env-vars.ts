export const RESERVED_KEY_PREFIX_RE = /^BUTTERBASE_/i;

export function validateEnvKeys(
  keys: string[]
): { code: 'reserved_key_prefix'; key: string } | null {
  for (const key of keys) {
    if (RESERVED_KEY_PREFIX_RE.test(key)) {
      return { code: 'reserved_key_prefix', key };
    }
  }
  return null;
}
