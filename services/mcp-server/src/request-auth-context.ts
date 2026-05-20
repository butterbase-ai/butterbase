import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestAuthContext {
  authorizationHeader?: string;
}

const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();

export async function runWithRequestAuthorizationHeader<T>(
  authorizationHeader: string | undefined,
  callback: () => Promise<T>
): Promise<T> {
  return requestAuthStorage.run({ authorizationHeader }, callback);
}

export function getRequestAuthorizationHeader(): string | undefined {
  return requestAuthStorage.getStore()?.authorizationHeader;
}
