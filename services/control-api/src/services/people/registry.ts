import type { PeopleAdapter, ProviderSlot } from './types.js';

const adapters = new Map<ProviderSlot, PeopleAdapter>();

export function registerPeopleAdapter(slot: ProviderSlot, adapter: PeopleAdapter): void {
  adapters.set(slot, adapter);
}

export function unregisterPeopleAdapter(slot: ProviderSlot): void {
  adapters.delete(slot);
}

export function getPeopleAdapter(slot: ProviderSlot): PeopleAdapter | null {
  return adapters.get(slot) ?? null;
}

export function listRegisteredSlots(): ProviderSlot[] {
  return Array.from(adapters.keys()).sort();
}
