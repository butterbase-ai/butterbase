import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Person } from '@/lib/types';
import {
  listEntities, entityToPerson, propose, updateEntityMerge, findPersonByEmail,
} from '@/lib/substrate';

function displayNameFor(p: Pick<Person, 'first_name' | 'last_name' | 'email'>): string {
  const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return full || p.email || 'Unnamed person';
}

export function usePeople() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.people(ws),
    queryFn: async () => {
      const entities = await listEntities('person', { limit: 200 });
      return entities
        .filter((e) => !e.attrs?.deleted_at)
        .map(entityToPerson);
    },
  });
}

export function usePeopleByCompany(companyId: string) {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: ['people', ws, 'byCompany', companyId],
    queryFn: async () => {
      const entities = await listEntities('person', { limit: 200 });
      return entities
        .filter((e) => !e.attrs?.deleted_at)
        .map(entityToPerson)
        .filter((p) => p.company_id === companyId);
    },
    enabled: !!companyId,
  });
}

export function useCreatePerson() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Person> & { first_name?: string | null }) => {
      const { workspace_id: _ws, id: _id, created_at: _c, updated_at: _u, substrate_entity_id: _s, ...attrs } =
        input as Partial<Person> & { substrate_entity_id?: string | null };

      // Dedupe by email if we have one — same contract crm-upsert-person had.
      if (attrs.email) {
        const existing = await findPersonByEmail(attrs.email);
        if (existing) {
          await updateEntityMerge(existing.id, attrs, {
            display_name: displayNameFor(input as Person),
          });
          await logActivity('person.updated', 'person', existing.id, { fields: Object.keys(attrs) });
          return entityToPerson({ ...existing, attrs: { ...existing.attrs, ...attrs } });
        }
      }

      const verdict = await propose('upsert_entity', {
        type: 'person',
        display_name: displayNameFor(input as Person),
        attrs,
      });
      const newId: string | undefined =
        verdict.result?.entity_id ?? verdict.result?.id ?? verdict.result?.entity?.id;
      if (!newId) throw new Error('substrate upsert_entity returned no entity id');
      await logActivity('person.created', 'person', newId, { name: displayNameFor(input as Person) });
      const created = await listEntities('person', { limit: 1 }); // refresh path; cheap
      return entityToPerson(created.find((e) => e.id === newId) ?? { id: newId, attrs } as any);
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: qk.people(ws) });
      if (row?.company_id) {
        qc.invalidateQueries({ queryKey: ['people', ws, 'byCompany', row.company_id] });
      }
    },
  });
}

export function useUpdatePerson() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Person> }) => {
      const patch = { ...input.patch } as Record<string, any>;
      // Strip non-attr bookkeeping fields the caller might still pass.
      delete patch.id;
      delete patch.workspace_id;
      delete patch.created_at;
      delete patch.updated_at;
      delete patch.substrate_entity_id;

      // updateEntityMerge interprets null/undefined as "delete this key" — which
      // matches the previous backend `clear_fields` semantics for free.
      const opts: { display_name?: string } = {};
      if ('first_name' in patch || 'last_name' in patch || 'email' in patch) {
        // Recompute display_name only when the user touched a contributing field.
        const fn = (patch.first_name as string | null | undefined) ?? undefined;
        const ln = (patch.last_name as string | null | undefined) ?? undefined;
        const em = (patch.email as string | null | undefined) ?? undefined;
        const guess = `${fn ?? ''} ${ln ?? ''}`.trim() || em || '';
        if (guess) opts.display_name = guess;
      }
      await updateEntityMerge(input.id, patch, opts);
      await logActivity('person.updated', 'person', input.id, { fields: Object.keys(patch) });
    },
    onSuccess: (_, input) => {
      qc.invalidateQueries({ queryKey: qk.people(ws) });
      qc.invalidateQueries({ queryKey: ['people', ws, 'byCompany'] });
      qc.invalidateQueries({ queryKey: qk.person(input.id) });
    },
  });
}

export function useDeletePerson() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Substrate has no delete_entity; soft-delete via attrs.deleted_at — list
      // hooks filter on this. Mirrors how meetings handle deletion.
      await updateEntityMerge(id, { deleted_at: new Date().toISOString() });
      await logActivity('person.deleted', 'person', id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.people(ws) });
      qc.invalidateQueries({ queryKey: ['people', ws, 'byCompany'] });
    },
  });
}
