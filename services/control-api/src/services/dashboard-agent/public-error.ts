const GENERIC = 'The operator could not complete this turn.';

/**
 * The activity-mode SSE deliberately hides raw provider errors. Keep hiding
 * internals, but do not hide a failure the person can act on: a model input
 * that exceeded the provider's length limit is fixed by asking for a narrower
 * result.
 */
export function publicAgentErrorMessage(message: string): string {
  if (/input length|invalid_parameter_error|context length|too large/i.test(message)) {
    return 'That result was too large for the model to summarize. Try a narrower request — subjects, senders, or snippets only.';
  }
  return GENERIC;
}
