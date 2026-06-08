// services/control-api/src/services/agent-runtime-client.ts

const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL ?? 'http://agent-runtime:7140';

// Both sides use the same internal-service shared secret. Agent-runtime reads
// it as INTERNAL_SERVICE_TOKEN; mainline control-api standardises on
// BUTTERBASE_INTERNAL_SECRET. The compose file plumbs the same value into both.
const INTERNAL_SERVICE_TOKEN =
  process.env.INTERNAL_SERVICE_TOKEN ??
  process.env.BUTTERBASE_INTERNAL_SECRET ??
  '';

export class AgentRuntimeError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

// Plan 1 awaits the runtime synchronously; bound the wait so a hung Python
// process can't wedge a control-api worker indefinitely. Plan 3 swaps this
// for fire-and-forget + Redis events.
const START_RUN_TIMEOUT_MS = 90_000;
const CONTROL_OP_TIMEOUT_MS = 30_000;

async function runtimePost(
  path: string,
  timeoutMs: number,
  body?: unknown,
  label = 'agent-runtime',
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const hasBody = body !== undefined;
    const response = await fetch(`${AGENT_RUNTIME_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-internal-service-token': INTERNAL_SERVICE_TOKEN,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 400) {
      const text = await response.text();
      throw new AgentRuntimeError(`${label} failed: ${text}`, response.status);
    }
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new AgentRuntimeError(
        `${label} timed out after ${timeoutMs}ms`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withRegion(path: string, region: string): string {
  // Region is appended as a query string so agent-runtime can pick the
  // correct runtime-plane pool from its app.state.pools dict. A request
  // can land on any region's machine — the python side does the lookup.
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}region=${encodeURIComponent(region)}`;
}

export async function startRun(runId: string, region: string): Promise<void> {
  await runtimePost(
    withRegion(`/internal/runs/${runId}/start`, region),
    START_RUN_TIMEOUT_MS,
    undefined,
    'agent-runtime start',
  );
}

export async function cancelRun(runId: string, region: string): Promise<void> {
  await runtimePost(
    withRegion(`/internal/runs/${runId}/cancel`, region),
    CONTROL_OP_TIMEOUT_MS,
    undefined,
    'agent-runtime cancel',
  );
}

export async function resumeRun(
  runId: string,
  region: string,
  input: unknown,
): Promise<void> {
  await runtimePost(
    withRegion(`/internal/runs/${runId}/resume`, region),
    CONTROL_OP_TIMEOUT_MS,
    { input },
    'agent-runtime resume',
  );
}
