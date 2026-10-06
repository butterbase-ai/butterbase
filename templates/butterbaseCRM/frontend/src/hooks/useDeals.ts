import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Deal, DealStage } from '@/lib/types';
import {
  listEntities, entityToDeal, propose, updateEntityMerge,
} from '@/lib/substrate';

// Deals live in substrate as type='project' entities with attrs.kind='deal'.
// The kind marker lets us reserve 'project' for future, non-deal use without a
// schema change.
function isDealEntity(e: { attrs?: any }): boolean {
  return (e.attrs?.kind ?? 'deal') === 'deal';
}

function dealAttrsFromPatch(patch: Partial<Deal>): Record<string, any> {
  const out: Record<string, any> = { kind: 'deal' };
  // Pass through the deal-specific fields, dropping bookkeeping columns the
  // substrate side computes for itself.
  for (const [k, v] of Object.entries(patch)) {
    if (['id', 'workspace_id', 'created_at', 'updated_at', 'created_by'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function useDeals() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.deals(ws),
    queryFn: async () => {
      const entities = await listEntities('project', { limit: 200 });
      return entities
        .filter((e) => !e.attrs?.deleted_at)
        .filter(isDealEntity)
        .map(entityToDeal);
    },
  });
}

export function useCreateDeal() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Deal> & { name: string; owner_user_id: string }) => {
      const attrs = dealAttrsFromPatch(input);
      const verdict = await propose('upsert_entity', {
        type: 'project',
        display_name: input.name,
        attrs,
      });
      const newId: string | undefined =
        verdict.result?.entity_id ?? verdict.result?.id ?? verdict.result?.entity?.id;
      if (!newId) throw new Error('substrate upsert_entity returned no entity id');
      await logActivity('deal.created', 'deal', newId, { name: input.name });
      return {
        ...input,
        id: newId,
        workspace_id: '',
        stage: input.stage ?? 'lead',
        currency: input.currency ?? 'USD',
        amount_cents: input.amount_cents ?? null,
        close_date: input.close_date ?? null,
        company_id: input.company_id ?? null,
        primary_person_id: input.primary_person_id ?? null,
        created_by: input.owner_user_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Deal;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.deals(ws) }),
  });
}

export function useUpdateDeal() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Deal>; previousStage?: DealStage }) => {
      const attrs = dealAttrsFromPatch(input.patch);
      // Keep the substrate display_name in sync when the user renames the deal.
      const opts = typeof input.patch.name === 'string' && input.patch.name.trim()
        ? { display_name: input.patch.name }
        : {};
      await updateEntityMerge(input.id, attrs, opts);

      const stageChanged = input.patch.stage && input.previousStage && input.previousStage !== input.patch.stage;
      if (stageChanged) {
        await logActivity('deal.stage_changed', 'deal', input.id, {
          from: input.previousStage,
          to: input.patch.stage,
        });
      } else {
        await logActivity('deal.updated', 'deal', input.id, { fields: Object.keys(input.patch) });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.deals(ws) }),
  });
}

export function useDeleteDeal() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Soft-delete via attrs.deleted_at — substrate has no delete_entity.
      await updateEntityMerge(id, { deleted_at: new Date().toISOString() });
      await logActivity('deal.deleted', 'deal', id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.deals(ws) }),
  });
}
