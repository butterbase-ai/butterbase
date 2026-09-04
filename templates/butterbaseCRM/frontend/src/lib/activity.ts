import { bb } from './butterbase';
import { useWorkspaceStore } from './workspace';
import type { EntityType } from './types';

export async function logActivity(
  kind: string,
  entity_type: EntityType,
  entity_id: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const workspace_id = useWorkspaceStore.getState().workspaceId;
  const { data: user } = await bb.auth.getUser();
  if (!workspace_id || !user) return;
  await bb.from('activities').insert({
    workspace_id,
    actor_user_id: user.id,
    kind,
    entity_type,
    entity_id,
    payload: payload ?? null,
  });
}
