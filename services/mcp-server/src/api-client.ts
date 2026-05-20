import { getRequestAuthorizationHeader } from './request-auth-context.js';

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

  return headers;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: getHeaders(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

export async function apiPost<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

export async function apiPatch<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

export async function apiPut<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers = getHeaders();
  // DELETE has no body — remove Content-Type to avoid Fastify's JSON parser failing on an empty body
  delete (headers as Record<string, string>)['Content-Type'];
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'DELETE',
    headers,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}
