import { config } from '../config.js';

export interface InvokeFunctionParams {
  appId: string;
  functionName: string;
  args: unknown;
  callerKind: 'end_user' | 'function' | 'dashboard';
  callerUserId: string | null;
  runId?: string;
}

export interface InvokeFunctionResult {
  ok: boolean;
  status_code: number;
  result?: unknown;
  error?: string;
}

export async function invokeFunction(p: InvokeFunctionParams): Promise<InvokeFunctionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-app-id': p.appId,
  };
  if (p.callerUserId) headers['x-user-id'] = p.callerUserId;
  if (p.runId) headers['x-run-id'] = p.runId;

  const resp = await fetch(`${config.runtimeUrl}/execute/${p.appId}/${p.functionName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(p.args ?? {}),
  });
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }

  if (!resp.ok) {
    return {
      ok: false,
      status_code: resp.status,
      error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
    };
  }
  return { ok: true, status_code: resp.status, result: parsed };
}
