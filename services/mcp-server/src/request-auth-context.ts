import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestAuthContext {
  authorizationHeader?: string;
  // Optional E2E bypass header forwarded only when BUTTERBASE_E2E=1 on both
  // the inbound /mcp route AND the downstream control-api. Lets the
  // existing x-test-user-id auth bypass flow through MCP tool wrappers.
  testUserId?: string;
  // Optional org scope for JWT MCP sessions — the client sends
  // x-organization-id on the /mcp POST to pick which org (of the user's
  // memberships) tool calls run against. Forwarded verbatim to control-api,
  // which validates membership before honoring it. bb_sk_* keys ignore this
  // (their org is baked into the key).
  organizationId?: string;
}

const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();

export async function runWithRequestAuthorizationHeader<T>(
  authorizationHeader: string | undefined,
  callback: () => Promise<T>
): Promise<T> {
  return requestAuthStorage.run({ authorizationHeader }, callback);
}

/**
 * Run a callback with both an Authorization header and an x-test-user-id
 * header in scope. The test header is forwarded only when present; on real
 * (non-E2E) traffic this is identical to runWithRequestAuthorizationHeader.
 */
export async function runWithRequestAuth<T>(
  ctx: { authorizationHeader?: string; testUserId?: string; organizationId?: string },
  callback: () => Promise<T>
): Promise<T> {
  return requestAuthStorage.run(ctx, callback);
}

export function getRequestAuthorizationHeader(): string | undefined {
  return requestAuthStorage.getStore()?.authorizationHeader;
}

export function getRequestTestUserId(): string | undefined {
  return requestAuthStorage.getStore()?.testUserId;
}

export function getRequestOrganizationId(): string | undefined {
  return requestAuthStorage.getStore()?.organizationId;
}
