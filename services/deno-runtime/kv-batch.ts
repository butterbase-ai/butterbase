export type KvBatchEntry = { value?: unknown; error?: unknown };

/**
 * Map a KV `_batch` result onto the caller's key order. A per-key error is
 * thrown, never converted to null: a decode failure must not read as absence.
 *
 * Embedded into the generated worker with `toString()`, so it must stay
 * self-contained (no imports or module-scope references).
 */
export function kvMgetValues(keys: string[], results: KvBatchEntry[]): unknown[] {
  return results.map((result, index) => {
    if (result && 'error' in result) {
      const error = new Error(`kv mget failed for key "${keys[index] ?? index}": ${String(result.error)}`);
      (error as { code?: unknown }).code = result.error;
      error.name = 'KvError';
      throw error;
    }
    return result && 'value' in result ? result.value : null;
  });
}
