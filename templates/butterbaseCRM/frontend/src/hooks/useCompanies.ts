import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Company } from '@/lib/types';
import {
  listEntities, entityToCompany, propose, updateEntityMerge, findCompanyByDomain,
} from '@/lib/substrate';

export function useCompanies() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.companies(ws),
    queryFn: async () => {
      const entities = await listEntities('company', { limit: 200 });
      return entities
        .filter((e) => !e.attrs?.deleted_at)
        .map(entityToCompany);
    },
  });
}

export function useCreateCompany() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Company> & { name: string }) => {
      const { workspace_id: _ws, id: _id, created_at: _c, updated_at: _u, substrate_entity_id: _s, ...attrs } =
        input as Partial<Company> & { substrate_entity_id?: string | null };

      // Dedupe by domain — same contract crm-upsert-company had.
      if (attrs.domain) {
        const existing = await findCompanyByDomain(String(attrs.domain));
        if (existing) {
          await updateEntityMerge(existing.id, attrs, { display_name: input.name });
          await logActivity('company.updated', 'company', existing.id, { fields: Object.keys(attrs) });
          return entityToCompany({ ...existing, attrs: { ...existing.attrs, ...attrs } });
        }
      }

      const verdict = await propose('upsert_entity', {
        type: 'company',
        display_name: input.name,
        attrs,
      });
      const newId: string | undefined =
        verdict.result?.entity_id ?? verdict.result?.id ?? verdict.result?.entity?.id;
      if (!newId) throw new Error('substrate upsert_entity returned no entity id');
      await logActivity('company.created', 'company', newId, { name: input.name });
      const created = await listEntities('company', { limit: 1 });
      return entityToCompany(created.find((e) => e.id === newId) ?? { id: newId, attrs } as any);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.companies(ws) }),
  });
}

export function useUpdateCompany() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Company> }) => {
      const patch = { ...input.patch } as Record<string, any>;
      delete patch.id;
      delete patch.workspace_id;
      delete patch.created_at;
      delete patch.updated_at;
      delete patch.substrate_entity_id;

      const opts: { display_name?: string } = {};
      if (typeof patch.name === 'string' && patch.name.trim()) {
        opts.display_name = patch.name;
      }
      await updateEntityMerge(input.id, patch, opts);
      await logActivity('company.updated', 'company', input.id, { fields: Object.keys(patch) });
    },
    onSuccess: (_, input) => {
      qc.invalidateQueries({ queryKey: qk.companies(ws) });
      qc.invalidateQueries({ queryKey: qk.company(input.id) });
    },
  });
}

export function useDeleteCompany() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await updateEntityMerge(id, { deleted_at: new Date().toISOString() });
      await logActivity('company.deleted', 'company', id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.companies(ws) }),
  });
}
