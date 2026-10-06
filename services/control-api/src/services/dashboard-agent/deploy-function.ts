/**
 * Function deployer for the Butterbase Dashboard Assistant (Plan 3c Task 3).
 *
 * Deploys a SINGLE-FILE serverless function from the working tree via the
 * `deploy_function` MCP tool.
 *
 * SCOPE / KNOWN LIMITATION: `deploy_function` only accepts one inline `code`
 * string (see docs/superpowers/plans/2026-07-08-dashboard-assistant-plan3c-task1-recon.md).
 * This deployer therefore reads exactly ONE entry file from the working tree:
 *   functions/<name>/index.ts   (falling back to .js, then .mjs)
 * Any other files under functions/<name>/ may be written by the file-op
 * primitives (Plan 3c Task 2) and persist in the per-app repo across turns,
 * but they are NOT bundled or sent to the deploy_function MCP call — the
 * runtime only ever receives the single entry file's contents. Multi-file
 * function bundling is out of scope for this task.
 */

import type { WorkingTreeCache } from './working-tree.js';

export type FnDeployProgress = {
  function_name: string;
  status: 'queued' | 'uploading' | 'live' | 'failed';
  url?: string;
  error?: string;
};

type McpCallResult = { ok: true; result: unknown } | { ok: false; error: string };

export type FnDeployDeps = {
  cache: WorkingTreeCache;
  mcp: { call(name: string, args: unknown, jwt: string): Promise<McpCallResult> };
  onFunctionDeployProgress: (evt: FnDeployProgress) => void;
};

export type FnDeployInput = {
  convId: string;
  appId: string;
  jwt: string;
  functionName: string;
  trigger?: { type: 'http' | 'cron' | 's3_upload' | 'webhook' | 'websocket'; config?: unknown };
  envVars?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
};

export type FnDeployResult =
  | { ok: true; url?: string; deploymentId?: string }
  | { ok: false; error: string };

const ENTRY_CANDIDATES = ['index.ts', 'index.js', 'index.mjs'];

export function createFunctionDeployer(deps: FnDeployDeps): { deploy(input: FnDeployInput): Promise<FnDeployResult> } {
  return {
    async deploy(input: FnDeployInput): Promise<FnDeployResult> {
      const { functionName } = input;
      deps.onFunctionDeployProgress({ function_name: functionName, status: 'queued' });

      const tree = deps.cache.get(input.convId, input.appId);
      let code: string | undefined;
      for (const candidate of ENTRY_CANDIDATES) {
        const path = `functions/${functionName}/${candidate}`;
        const content = tree?.get(path)?.content;
        if (content !== undefined) {
          code = content;
          break;
        }
      }
      if (code === undefined) {
        const error = 'entry file not found';
        deps.onFunctionDeployProgress({ function_name: functionName, status: 'failed', error });
        return { ok: false, error };
      }

      deps.onFunctionDeployProgress({ function_name: functionName, status: 'uploading' });

      const args: Record<string, unknown> = {
        app_id: input.appId,
        name: functionName,
        code,
        trigger: input.trigger ?? { type: 'http' },
      };
      if (input.envVars !== undefined) args.envVars = input.envVars;
      if (input.timeoutMs !== undefined) args.timeoutMs = input.timeoutMs;
      if (input.memoryLimitMb !== undefined) args.memoryLimitMb = input.memoryLimitMb;

      const call = await deps.mcp.call('deploy_function', args, input.jwt);
      if (!call.ok) {
        deps.onFunctionDeployProgress({ function_name: functionName, status: 'failed', error: call.error });
        return { ok: false, error: call.error };
      }

      const result = (call.result ?? {}) as { id?: string; url?: string };
      deps.onFunctionDeployProgress({ function_name: functionName, status: 'live', url: result.url });
      return { ok: true, url: result.url, deploymentId: result.id };
    },
  };
}
