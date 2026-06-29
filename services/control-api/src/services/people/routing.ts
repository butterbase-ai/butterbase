import { config } from '../../config.js';
import type { ProviderSlot } from './types.js';

export type ActionName = 'search_person' | 'search_company' | 'get_profile' | 'queue_email_lookup';

export function resolveSlot(action: ActionName): ProviderSlot {
  return (config.people.routing as Record<ActionName, ProviderSlot>)[action] ?? 'primary';
}
