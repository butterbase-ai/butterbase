import { createRegisteredToolServer } from './tool-registry.js';
import { startActiveWindowListener } from './eligibility-listener.js';
import { isActiveWindowCached, startActiveWindowPoller } from './active-window-cache.js';
export { runWithRequestAuthorizationHeader, runWithRequestAuth, getRequestAuthorizationHeader, getRequestTestUserId } from './request-auth-context.js';

let runtimeStarted = false;

/** Explicit, process-wide startup. Importing or constructing a registry is inert. */
export function startButterbaseMcpRuntime(): void {
  if (runtimeStarted) return;
  runtimeStarted = true;
  startActiveWindowPoller();
  if (process.env.CONTROL_DB_URL) {
    void startActiveWindowListener(process.env.CONTROL_DB_URL).catch((err) =>
      console.error('failed to start active-window listener', err)
    );
  }
}

export function filterToolsByActiveWindow<T extends { name: string }>(tools: T[], activeWindow: boolean): T[] {
  return activeWindow ? tools : tools.filter(t => t.name !== 'submit_hackathon_entry');
}

export async function createButterbaseMcpServer(options: Parameters<typeof createRegisteredToolServer>[0] = {}) {
  const server = await createRegisteredToolServer(options);
  const lowLevel = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const originalListTools = lowLevel._requestHandlers.get('tools/list');
  if (!originalListTools) {
    throw new Error('MCP SDK private surface changed: ListTools handler unavailable');
  }
  lowLevel._requestHandlers.set('tools/list', async (request, extra) => {
    const original = (await originalListTools(request, extra)) as { tools: Array<{ name: string }>; [k: string]: unknown };
    return { ...original, tools: filterToolsByActiveWindow(original.tools, isActiveWindowCached()) };
  });
  startButterbaseMcpRuntime();
  return server;
}
