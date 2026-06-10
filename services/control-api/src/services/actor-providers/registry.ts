import { ProviderUnavailableError, type ActorProvider } from './types.js';

const registry = new Map<ActorProvider['key'], ActorProvider>();

export function registerActorProvider(p: ActorProvider): void {
  registry.set(p.key, p);
}

export function getActorProvider(key: ActorProvider['key']): ActorProvider {
  const p = registry.get(key);
  if (!p) throw new ProviderUnavailableError(key);
  return p;
}

/** @internal — test-only helper to clear the registry between cases. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
