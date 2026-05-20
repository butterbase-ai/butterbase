/**
 * Extract a safe, user-facing error message from any caught error.
 * Returns the error message without stack traces or internal system details.
 */
export function apiError(error: unknown, fallback: string): { error: string; details?: string } {
  if (error instanceof Error) {
    return { error: fallback, details: error.message };
  }
  if (typeof error === 'string') {
    return { error: fallback, details: error };
  }
  return { error: fallback };
}
