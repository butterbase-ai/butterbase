import { getMergedConfig } from './config.js';
import { parseApiError } from '@butterbase/sdk';

export interface ApiError {
  error: string;
  details?: unknown;
  hint?: string;
}

/**
 * fetch() wrapper that turns connection failures and unparseable bodies into
 * actionable errors. A 0-byte ECONNREFUSED used to surface as
 * "Invalid or revoked API key" because res.json() threw before the
 * status-based error mapper ran.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const cause = (err as any)?.cause;
    const code: string | undefined = cause?.code ?? (err as any)?.code;
    const origin = safeOrigin(url);
    const hint = isLocalOrigin(origin)
      ? ` Run \`butterbase config set endpoint https://api.butterbase.ai\` to point at the hosted platform.`
      : '';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
      throw new Error(`Could not reach ${origin} (${code}).${hint}`);
    }
    throw new Error(`Network error reaching ${origin}: ${(err as Error)?.message ?? String(err)}`);
  }

  if (res.status === 204) return { status: 204, body: {} };

  const text = await res.text();
  if (!text) return { status: res.status, body: {} };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${safeOrigin(url)} (non-JSON response: ${truncate(text, 200)})`);
    }
    throw new Error(`Unexpected non-JSON response from ${safeOrigin(url)}: ${truncate(text, 200)}`);
  }
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function isLocalOrigin(origin: string): boolean {
  return /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/i.test(origin);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/**
 * Get authorization headers
 */
async function getHeaders(): Promise<HeadersInit> {
  const config = await getMergedConfig();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return headers;
}

/**
 * Get base URL from config
 */
async function getBaseUrl(): Promise<string> {
  const config = await getMergedConfig();
  return config.endpoint;
}

/**
 * Make a GET request
 */
function extractErrorMessage(body: any): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error?.message) return body.error.message;
  if (body.message) return body.message;
  return 'Request failed';
}

export async function apiGet<T>(path: string): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const { status, body } = await fetchJson(`${baseUrl}${path}`, { headers });

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

/**
 * Make a POST request
 */
export async function apiPost<T>(path: string, data: unknown): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const { status, body } = await fetchJson(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

/**
 * Make a PATCH request
 */
export async function apiPatch<T>(path: string, data: unknown): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const { status, body } = await fetchJson(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(data),
  });

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

/**
 * Make a DELETE request
 */
export async function apiDelete<T>(path: string): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();
  // DELETE has no body — remove Content-Type to avoid Fastify's JSON parser rejecting an empty body
  delete (headers as Record<string, string>)['Content-Type'];

  const { status, body } = await fetchJson(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers,
  });

  if (status === 204) return {} as T;

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

// MCP tool wrappers

export async function initApp(name: string) {
  return apiPost('/init', { name });
}

export async function listApps() {
  return apiGet('/apps');
}

export async function deleteApp(appId: string) {
  return apiDelete(`/apps/${appId}`);
}

export async function getSchema(appId: string) {
  return apiGet(`/v1/${appId}/schema`);
}

export async function applySchema(appId: string, schema: any, dryRun?: boolean, name?: string) {
  return apiPost(`/v1/${appId}/schema/apply`, { schema, dry_run: dryRun, name });
}

export async function deployFunction(appId: string, data: {
  name: string;
  code: string;
  description?: string;
  envVars?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  trigger?: { type: string; config?: any };
  triggers?: Array<{ type: string; config?: any; enabled?: boolean }>;
  agent_tool?: boolean;
  agent_tool_description?: string;
  agent_tool_mode?: 'read_only' | 'read_write';
  agent_tool_exposed_to?: 'developer_only' | 'end_user';
}) {
  return apiPost(`/v1/${appId}/functions`, data);
}

export async function listFunctions(appId: string) {
  return apiGet(`/v1/${appId}/functions`);
}

export async function getFunctionLogs(
  appId: string,
  functionName: string,
  level?: string,
  limit?: number,
  includeDeleted?: boolean,
) {
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (limit) params.set('limit', String(limit));
  if (includeDeleted) params.set('include_deleted', 'true');
  const query = params.toString();
  return apiGet(`/v1/${appId}/functions/${functionName}/logs${query ? `?${query}` : ''}`);
}

export async function pauseApp(appId: string, paused: boolean, reason?: string) {
  return apiPatch(`/v1/${appId}/config/pause`, { paused, reason });
}

export async function deleteFunction(appId: string, functionName: string) {
  return apiDelete(`/v1/${appId}/functions/${functionName}`);
}

export async function generateUploadUrl(appId: string, filename: string, contentType: string, sizeBytes: number, isPublic?: boolean) {
  return apiPost(`/storage/${appId}/upload`, { filename, contentType, sizeBytes, public: isPublic ?? false });
}

export async function listStorageObjects(appId: string) {
  return apiGet(`/storage/${appId}/objects`);
}

export async function deleteStorageObject(appId: string, objectId: string) {
  return apiDelete(`/storage/${appId}/${objectId}`);
}

/**
 * Generic fetch helper — method + optional body
 */
export async function apiFetch<T = unknown>(method: string, path: string, data?: unknown): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const init: RequestInit = { method, headers };
  if (data !== undefined) {
    init.body = JSON.stringify(data);
  } else {
    // No body — remove Content-Type to avoid parsers rejecting empty body
    delete (headers as Record<string, string>)['Content-Type'];
  }

  const { status, body } = await fetchJson(`${baseUrl}${path}`, init);

  if (status === 204) return {} as T;

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

/**
 * Make a PUT request
 */
export async function apiPut<T>(path: string, data: unknown): Promise<T> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const { status, body } = await fetchJson(`${baseUrl}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });

  if (status < 200 || status >= 300) {
    throw parseApiError(status, body);
  }

  return body as T;
}

/**
 * Upload binary data to a presigned URL (no auth headers)
 */
export async function uploadBinary(url: string, buffer: Buffer, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(buffer),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }
}

// — Deployment wrappers —

export async function createDeployment(appId: string, framework?: string) {
  return apiPost<{
    id: string;
    uploadUrl: string;
    expiresIn: number;
    maxSizeBytes: number;
  }>(`/v1/${appId}/frontend/deployments`, { framework });
}

export async function startDeployment(appId: string, deploymentId: string) {
  return apiPost<{ id: string; status: string; url: string }>(
    `/v1/${appId}/frontend/deployments/${deploymentId}/start`, {}
  );
}

export async function getDeployment(appId: string, deploymentId: string) {
  return apiGet<{
    id: string; status: string; url: string; framework: string;
    fileCount: number; totalSizeBytes: number; error?: string;
  }>(`/v1/${appId}/frontend/deployments/${deploymentId}`);
}

export async function listDeployments(appId: string) {
  return apiGet<{ deployments: any[] }>(`/v1/${appId}/frontend/deployments`);
}

// — Edge SSR deployment wrappers —

export async function createEdgeSsrDeployment(appId: string, framework: string) {
  return apiPost<{
    id: string;
    uploadUrl: string;
    expiresIn: number;
    maxSizeBytes: number;
  }>(`/v1/${appId}/edge-ssr/deployments`, { framework });
}

export async function startEdgeSsrDeployment(appId: string, deploymentId: string) {
  return apiPost<{ id: string; status: string; url: string }>(
    `/v1/${appId}/edge-ssr/deployments/${deploymentId}/start`, {}
  );
}

export async function getEdgeSsrDeployment(appId: string, deploymentId: string) {
  return apiGet<{
    id: string; status: string; url: string; framework: string;
    fileCount: number; totalSizeBytes: number; error?: string;
  }>(`/v1/${appId}/edge-ssr/deployments/${deploymentId}`);
}

// — Data wrappers —

export async function queryTable(appId: string, table: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return apiGet<any[]>(`/v1/${appId}/${table}${qs ? `?${qs}` : ''}`);
}

export async function insertRow(appId: string, table: string, data: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/${table}`, data);
}

// — Env wrappers —

export async function setFrontendEnv(appId: string, vars: Record<string, string>) {
  return apiPut<{ message: string; keys: string[] }>(`/v1/${appId}/frontend/env`, vars);
}

export async function getFrontendEnv(appId: string) {
  return apiGet<{ envVars: { key: string; createdAt: string; updatedAt: string }[] }>(`/v1/${appId}/frontend/env`);
}

// — Keys wrappers —

export async function generateApiKey(
  name: string,
  scopes?: string[],
  scope?: 'app' | 'substrate'
) {
  const body: Record<string, unknown> = { name };
  if (scopes && scopes.length > 0) body.scopes = scopes;
  if (scope) body.scope = scope;
  return apiPost<{ key: string; keyId: string; name: string }>('/api-keys', body);
}

export async function listApiKeys() {
  return apiGet<{ keys: any[] }>('/api-keys');
}

export async function revokeApiKey(keyId: string) {
  return apiDelete(`/api-keys/${keyId}`);
}

// — Config wrappers —

export async function getAppConfig(appId: string) {
  return apiGet<any>(`/v1/${appId}/config`);
}

export async function updateStorageConfig(appId: string, config: { publicReadEnabled?: boolean }) {
  return apiPatch<any>(`/v1/${appId}/config/storage`, config);
}

export async function listMigrations(appId: string) {
  return apiGet<any>(`/v1/${appId}/migrations`);
}

// — Realtime wrappers —

export async function configureRealtime(appId: string, tables: string[]) {
  return apiPost<{ configured: Array<{ table: string; status: string }> }>(
    `/v1/${appId}/realtime/configure`, { tables }
  );
}

export async function getRealtimeConfig(appId: string) {
  return apiGet<any>(`/v1/${appId}/realtime/config`);
}

export async function disableRealtime(appId: string, tableName: string) {
  return apiDelete<{ table: string; status: string }>(`/v1/${appId}/realtime/${tableName}`);
}

// — Integration wrappers —

export async function getAvailableIntegrations(appId: string, search?: string) {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  return apiGet<{ integrations: any[] }>(`/v1/${appId}/integrations/available${query}`);
}

export async function getIntegrationConfig(appId: string) {
  return apiGet<{ integrations: any[] }>(`/v1/${appId}/integrations/config`);
}

export async function configureIntegration(appId: string, toolkit: string, displayName?: string, scopes?: string[]) {
  const body: Record<string, unknown> = { toolkit };
  if (displayName) body.displayName = displayName;
  if (scopes && scopes.length > 0) body.scopes = scopes;
  return apiPost<any>(`/v1/${appId}/integrations/configure`, body);
}

export async function disableIntegration(appId: string, toolkit: string) {
  return apiDelete<void>(`/v1/${appId}/integrations/configure/${encodeURIComponent(toolkit)}`);
}

export async function connectIntegration(appId: string, toolkit: string, redirectUrl: string, userId?: string, scopes?: string[]) {
  const body: Record<string, unknown> = { toolkit, redirectUrl };
  if (userId) body.userId = userId;
  if (scopes && scopes.length > 0) body.scopes = scopes;
  return apiPost<{ authUrl: string; connectionRequestId: string }>(`/v1/${appId}/integrations/connect`, body);
}

export async function listConnections(appId: string) {
  return apiGet<{ connections: any[] }>(`/v1/${appId}/integrations/connections`);
}

export async function disconnectAccount(appId: string, connectionId: string) {
  return apiDelete<void>(`/v1/${appId}/integrations/connections/${encodeURIComponent(connectionId)}`);
}

export async function listIntegrationTools(appId: string, toolkit?: string) {
  const query = toolkit ? `?toolkit=${encodeURIComponent(toolkit)}` : '';
  return apiGet<{ tools: any[] }>(`/v1/${appId}/integrations/tools${query}`);
}

export async function executeIntegrationTool(appId: string, toolName: string, params: Record<string, unknown>, userId?: string) {
  const body: Record<string, unknown> = { toolName, params };
  if (userId) body.userId = userId;
  return apiPost<{ successful: boolean; data: unknown; error?: string }>(`/v1/${appId}/integrations/execute`, body);
}

// — Custom domain wrappers —

export async function listCustomDomains(appId: string) {
  return apiGet<{ domains: any[] }>(`/v1/${appId}/custom-domains`);
}

export async function addCustomDomain(appId: string, hostname: string) {
  return apiPost<any>(`/v1/${appId}/custom-domains`, { hostname });
}

export async function getCustomDomainStatus(appId: string, domainId: string) {
  return apiGet<any>(`/v1/${appId}/custom-domains/${domainId}/status`);
}

export async function verifyCustomDomain(appId: string, domainId: string) {
  return apiPost<any>(`/v1/${appId}/custom-domains/${domainId}/verify`, {});
}

export async function deleteCustomDomain(appId: string, domainId: string) {
  return apiDelete<void>(`/v1/${appId}/custom-domains/${domainId}`);
}

// — Partners wrappers —

export async function listPartners(appId: string, hackathonSlug: string) {
  return apiGet<{ partners: Array<{
    slug: string; display_name: string; description: string | null;
    docs_url: string | null; proxy_url_template: string; contact_message: string;
    status: 'available' | 'exhausted';
  }> }>(`/v1/${appId}/partners/${encodeURIComponent(hackathonSlug)}`);
}

// — Durable Object wrappers —

export async function createDurableObject(appId: string, name: string, code: string, accessMode: string) {
  return apiPost(`/v1/${appId}/durable-objects`, { name, code, access_mode: accessMode });
}

export async function listDurableObjects(appId: string) {
  return apiGet(`/v1/${appId}/durable-objects`);
}

export async function getDurableObject(appId: string, name: string) {
  return apiGet(`/v1/${appId}/durable-objects/${name}`);
}

export async function deleteDurableObject(appId: string, name: string) {
  return apiDelete(`/v1/${appId}/durable-objects/${name}`);
}

export async function getDoUsage(appId: string, name: string) {
  return apiGet(`/v1/${appId}/durable-objects/${name}/usage`);
}

export async function listDoEnv(appId: string) {
  return apiGet<{ keys: string[] }>(`/v1/${appId}/durable-objects/env`);
}

export async function setDoEnv(appId: string, key: string, value: string) {
  return apiPut<{ key: string; redeployed: boolean }>(
    `/v1/${appId}/durable-objects/env/${encodeURIComponent(key)}`,
    { value },
  );
}

export async function deleteDoEnv(appId: string, key: string) {
  return apiDelete<{ deleted: boolean; key: string; redeployed: boolean }>(
    `/v1/${appId}/durable-objects/env/${encodeURIComponent(key)}`,
  );
}

// ─── RLS wrappers ────────────────────────────────────────────────────────────

export async function listRlsPolicies(appId: string) {
  return apiGet<any>(`/v1/${appId}/rls`);
}

export async function createUserIsolationPolicy(appId: string, body: {
  table_name: string;
  user_column: string;
  public_read_column?: string;
}) {
  return apiPost<any>(`/v1/${appId}/rls`, body);
}

export async function createRlsPolicy(appId: string, body: {
  table_name: string;
  policy_name: string;
  command?: string;
  role?: string;
  using_expression?: string;
  with_check_expression?: string;
  restrictive?: boolean;
  user_column?: string;
}) {
  return apiPost<any>(`/v1/${appId}/rls/policies`, body);
}

export async function enableRls(appId: string, tableName: string) {
  return apiPost<any>(`/v1/${appId}/rls/enable`, { table_name: tableName });
}

export async function deleteRlsTablePolicies(appId: string, table: string) {
  return apiDelete<any>(`/v1/${appId}/rls/${encodeURIComponent(table)}`);
}

export async function deleteRlsPolicy(appId: string, table: string, policyName: string) {
  return apiDelete<any>(`/v1/${appId}/rls/${encodeURIComponent(table)}/${encodeURIComponent(policyName)}`);
}

// ─── Billing wrappers ─────────────────────────────────────────────────────────

export async function getBilling() {
  return apiGet<any>('/dashboard/billing');
}

export async function getUsage(params: { startDate?: string; endDate?: string; meterType?: string }) {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  if (params.meterType) qs.set('meterType', params.meterType);
  const query = qs.toString();
  return apiGet<any>(`/dashboard/usage${query ? `?${query}` : ''}`);
}

export async function createBillingCheckout(planId: string, successUrl?: string, cancelUrl?: string) {
  return apiPost<any>('/dashboard/billing/checkout', { planId, successUrl, cancelUrl });
}

export async function createBillingPortal() {
  return apiPost<{ url: string }>('/dashboard/billing/portal', {});
}

export async function createTopup(amount: number) {
  return apiPost<any>('/dashboard/billing/topup', { amount });
}

export async function getSpendingCap() {
  return apiGet<any>('/dashboard/billing/spending-cap');
}

export async function raiseSpendingCap(body: Record<string, unknown>) {
  return apiPut<any>('/dashboard/billing/spending-cap', body);
}

export async function listBillingPlans() {
  return apiGet<any>('/dashboard/plans');
}

// ─── Functions invoke + env wrappers ─────────────────────────────────────────

export async function invokeFunction(appId: string, name: string, body: unknown) {
  return apiPost<any>(`/v1/${appId}/functions/${encodeURIComponent(name)}/invoke`, body);
}

export async function updateFunctionEnv(appId: string, name: string, envVars: Record<string, string>) {
  return apiPatch<any>(`/v1/${appId}/functions/${encodeURIComponent(name)}/env`, { envVars });
}

export async function getFunction(appId: string, name: string) {
  return apiGet<any>(`/v1/${appId}/functions/${encodeURIComponent(name)}`);
}

// ─── RAG wrappers ─────────────────────────────────────────────────────────────

export async function ragCreateCollection(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/rag/collections`, body);
}

export async function ragListCollections(appId: string) {
  return apiGet<any>(`/v1/${appId}/rag/collections`);
}

export async function ragGetCollection(appId: string, name: string) {
  return apiGet<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(name)}`);
}

export async function ragDeleteCollection(appId: string, name: string) {
  return apiDelete<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(name)}`);
}

export async function ragIngest(appId: string, collection: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(collection)}/ingest`, body);
}

export async function ragListDocuments(appId: string, collection: string) {
  return apiGet<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(collection)}/documents`);
}

export async function ragDeleteDocument(appId: string, collection: string, docId: string) {
  return apiDelete<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(docId)}`);
}

export async function ragQuery(appId: string, collection: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/rag/collections/${encodeURIComponent(collection)}/query`, body);
}

// ── AI ──
export async function aiChat(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/chat/completions`, body);
}
export async function aiEmbed(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/embeddings`, body);
}
export async function aiListModels(appId: string) {
  return apiGet<any>(`/v1/${appId}/ai/models`);
}
export async function aiGetConfig(appId: string) {
  return apiGet<any>(`/v1/${appId}/ai/config`);
}
export async function aiUpdateConfig(appId: string, body: Record<string, unknown>) {
  return apiPut<any>(`/v1/${appId}/ai/config`, body);
}
export async function aiGetUsage(appId: string, q: { startDate?: string; endDate?: string } = {}) {
  const p = new URLSearchParams();
  if (q.startDate) p.set('startDate', q.startDate);
  if (q.endDate) p.set('endDate', q.endDate);
  const qs = p.toString();
  return apiGet<any>(`/v1/${appId}/ai/usage${qs ? `?${qs}` : ''}`);
}

// ── OAuth admin ──
export async function oauthCreate(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/auth/oauth-config`, body);
}
export async function oauthList(appId: string) {
  return apiGet<any>(`/v1/${appId}/auth/oauth-config`);
}
export async function oauthGet(appId: string, provider: string) {
  return apiGet<any>(`/v1/${appId}/auth/oauth-config/${encodeURIComponent(provider)}`);
}
export async function oauthUpdate(appId: string, provider: string, body: Record<string, unknown>) {
  return apiPatch<any>(`/v1/${appId}/auth/oauth-config/${encodeURIComponent(provider)}`, body);
}
export async function oauthDelete(appId: string, provider: string) {
  return apiDelete<any>(`/v1/${appId}/auth/oauth-config/${encodeURIComponent(provider)}`);
}

// ── Audit logs ──
export async function queryAuditLogs(appId: string, q: Record<string, string | number | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const qs = p.toString();
  return apiGet<any>(`/v1/${appId}/audit-logs${qs ? `?${qs}` : ''}`);
}

// ── App config (extension — getAppConfig + updateStorageConfig already exist above) ──
export async function updateCors(appId: string, body: Record<string, unknown>) {
  return apiPatch<any>(`/v1/${appId}/config/cors`, body);
}
export async function updateJwt(appId: string, body: Record<string, unknown>) {
  return apiPatch<any>(`/v1/${appId}/config/jwt`, body);
}
export async function updateAccessMode(appId: string, mode: 'public' | 'authenticated') {
  return apiPatch<any>(`/v1/${appId}/config/access-mode`, { access_mode: mode });
}
export async function secureApp(appId: string, body: Record<string, unknown> = {}) {
  return apiPost<any>(`/v1/${appId}/secure`, body);
}

// ── Regions + move-app ──
export async function listRegions() {
  return apiGet<any>(`/v1/regions`);
}
export async function moveApp(appId: string, destRegion: string) {
  return apiPost<any>(`/v1/apps/${appId}/move`, { dest_region: destRegion });
}
export async function getMigration(appId: string, mid: string) {
  return apiGet<any>(`/v1/apps/${appId}/migrations/${mid}`);
}
export async function getActiveMigration(appId: string) {
  return apiGet<any>(`/v1/apps/${appId}/migrations/active`);
}
export async function abortMigration(appId: string, mid: string) {
  return apiPost<any>(`/v1/apps/${appId}/migrations/${mid}/abort`, {});
}
export async function reverseMigration(appId: string, mid: string) {
  return apiPost<any>(`/v1/apps/${appId}/migrations/${mid}/reverse`, {});
}
export async function listSourceReplicas() {
  return apiGet<any>(`/v1/source-replicas`);
}
export async function tearDownSourceReplica(mid: string) {
  return apiDelete<any>(`/v1/source-replicas/${mid}`);
}

// ── App-level billing (Stripe Connect) ──
export async function createPlan(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/billing/plans`, body);
}
export async function updatePlan(appId: string, planId: string, body: Record<string, unknown>) {
  return apiPut<any>(`/v1/${appId}/billing/plans/${planId}`, body);
}
export async function listPlans(appId: string) {
  return apiGet<any>(`/v1/${appId}/billing/plans`);
}
export async function createProduct(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/billing/products`, body);
}
export async function updateProduct(appId: string, productId: string, body: Record<string, unknown>) {
  return apiPut<any>(`/v1/${appId}/billing/products/${productId}`, body);
}
export async function listProducts(appId: string) {
  return apiGet<any>(`/v1/${appId}/billing/products`);
}
export async function subscribePlan(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/billing/subscribe`, body);
}
export async function getSubscription(appId: string) {
  return apiGet<any>(`/v1/${appId}/billing/subscription`);
}
export async function cancelSubscription(appId: string) {
  return apiPost<any>(`/v1/${appId}/billing/cancel`, {});
}
export async function purchase(appId: string, body: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/billing/purchase`, body);
}
export async function listOrders(appId: string) {
  return apiGet<any>(`/v1/${appId}/billing/orders`);
}
export async function getOrder(appId: string, orderId: string) {
  return apiGet<any>(`/v1/${appId}/billing/orders/${orderId}`);
}

export async function setAppVisibility(appId: string, body: { visibility: 'public' | 'private'; listed?: boolean }) {
  return apiPatch(`/v1/${appId}/config/visibility`, body);
}

// — Agent wrappers —
export async function listAgents(appId: string) {
  return apiGet<{ agents: any[] }>(`/v1/${appId}/agents`);
}

export async function getAgent(appId: string, name: string) {
  return apiGet<any>(`/v1/${appId}/agents/${encodeURIComponent(name)}`);
}

export async function createAgent(appId: string, spec: Record<string, unknown>) {
  return apiPost<any>(`/v1/${appId}/agents`, spec);
}

export async function updateAgent(appId: string, name: string, body: Record<string, unknown>) {
  return apiPatch<any>(`/v1/${appId}/agents/${encodeURIComponent(name)}`, body);
}

export async function deleteAgent(appId: string, name: string) {
  return apiDelete<void>(`/v1/${appId}/agents/${encodeURIComponent(name)}`);
}
