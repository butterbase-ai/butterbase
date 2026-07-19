import { getRequestAuthorizationHeader, getRequestTestUserId, getRequestOrganizationId } from './request-auth-context.js';

// On Fly (production), default to the public Fly-anycast URL so that
// auto-CRUD/storage/function requests for cross-region apps pass through
// the Fly proxy and are intercepted by the Fly-Replay header set by
// services/control-api/src/plugins/fly-replay.ts. A localhost loopback
// would bypass Fly proxy and silently return the empty 204 fly-replay
// response, breaking cross-region MCP tool calls.
// In local dev (no FLY_REGION), keep the localhost default so the
// embedded MCP talks to the local control-api directly.
const DEFAULT_BASE_URL = process.env.FLY_REGION
  ? 'https://api.butterbase.ai'
  : 'http://localhost:4000';

export function getBaseUrl() {
  return process.env.CONTROL_API_URL || DEFAULT_BASE_URL;
}

function getApiKey() {
  return process.env.BUTTERBASE_API_KEY;
}

export interface ApiError {
  error: string;
  details?: unknown;
  hint?: string;
}

export function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  // Prefer request-scoped auth from incoming /mcp call; fallback to service key.
  const authorizationHeader = getRequestAuthorizationHeader();
  if (authorizationHeader) {
    headers['Authorization'] = authorizationHeader;
  } else if (getApiKey()) {
    headers['Authorization'] = `Bearer ${getApiKey()}`;
  }

  // Forward the E2E test-user header when present (set only by /mcp under
  // BUTTERBASE_E2E=1 on the inbound side). Lets unauthenticated MCP smoke
  // tests reach the control-api routes through the same bypass the route
  // layer honours. Real traffic never carries this.
  const testUserId = getRequestTestUserId();
  if (testUserId) {
    (headers as Record<string, string>)['x-test-user-id'] = testUserId;
  }

  // Forward the caller-selected org scope for JWT MCP sessions. control-api's
  // auth plugin verifies membership before honoring it; unauthorized values
  // are silently dropped there.
  const orgId = getRequestOrganizationId();
  if (orgId) {
    (headers as Record<string, string>)['x-organization-id'] = orgId;
  }

  return headers;
}

async function parseResponse<T>(res: Response): Promise<T> {
  // 204 No Content and other empty bodies (e.g. successful PUT on KV expose
  // rules) return no JSON — parsing res.json() throws on empty input. Read as
  // text and only JSON-parse when there's content.
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: getHeaders(),
  });
  return parseResponse<T>(res);
}

export async function apiPost<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  return parseResponse<T>(res);
}

export async function apiPatch<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  return parseResponse<T>(res);
}

export async function apiPut<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  return parseResponse<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers = getHeaders();
  // DELETE has no body — remove Content-Type to avoid Fastify's JSON parser failing on an empty body
  delete (headers as Record<string, string>)['Content-Type'];
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'DELETE',
    headers,
  });
  return parseResponse<T>(res);
}
