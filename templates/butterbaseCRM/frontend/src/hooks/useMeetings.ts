// Substrate-primary meeting hooks.
//
// Reads source from substrate entities of type='event' and map via entityToMeeting.
// Writes route through crm-upsert-meeting (which proposes upsert_entity / update_entity).
//
// Workspace scope: substrate is per-user, so we filter listEntities('event') by
// attrs.workspace_id so multi-workspace users don't see cross-workspace events.
// (Same eventual-consistency trade-off as useCompanies/usePeople.)
//
// Soft delete: substrate has no delete_entity. useDeleteMeeting sets
// attrs.deleted_at; read paths filter rows where it's present.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bbInvoke } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Meeting } from '@/lib/types';
import { listEntities, entityToMeeting, updateEntityMerge } from '@/lib/substrate';

function isAliveInWorkspace(e: { attrs: Record<string, any> | null }, ws: string): boolean {
  const a = e.attrs ?? {};
  if (a.deleted_at) return false;
  return String(a.workspace_id ?? '') === ws;
}

export function useMeetings() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.meetings(ws),
    queryFn: async () => {
      const entities = await listEntities('event', { limit: 200 });
      return entities
        .filter((e) => isAliveInWorkspace(e, ws))
        .map(entityToMeeting)
        .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''));
    },
    enabled: !!ws,
  });
}

export function useMeetingsByEntity({ companyId, dealId }: { companyId?: string; dealId?: string }) {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: ['meetings', ws, 'byEntity', companyId ?? null, dealId ?? null],
    queryFn: async () => {
      const entities = await listEntities('event', { limit: 200 });
      return entities
        .filter((e) => isAliveInWorkspace(e, ws))
        .filter((e) => {
          if (companyId && String(e.attrs?.company_id ?? '') !== companyId) return false;
          if (dealId && String(e.attrs?.deal_id ?? '') !== dealId) return false;
          return true;
        })
        .map(entityToMeeting)
        .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''));
    },
    enabled: !!ws && !!(companyId || dealId),
  });
}

export function useCreateMeeting() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Meeting> & { title: string; starts_at: string }) => {
      const {
        workspace_id: _ws, id: _id, created_at: _c, updated_at: _u, created_by: _cb,
        ...attrs
      } = input as Partial<Meeting>;
      const { data: fnRes, error: fnErr } = await bbInvoke<{ id: string; created: boolean }>(
        'crm-upsert-meeting',
        {
          workspace_id: ws,
          source: 'ui',
          attrs,
        },
      );
      if (fnErr || !fnRes?.id) throw fnErr ?? new Error('crm-upsert-meeting: no id returned');
      await logActivity('meeting.created', 'meeting', fnRes.id, { title: input.title });
      // Return a synthetic Meeting row; the next refetch will populate properly.
      return {
        id: fnRes.id,
        workspace_id: ws,
        title: input.title,
        starts_at: input.starts_at,
        ends_at: input.ends_at ?? null,
        location: input.location ?? null,
        notes: input.notes ?? null,
        company_id: input.company_id ?? null,
        deal_id: input.deal_id ?? null,
        created_by: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Meeting;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
      if (row.company_id || row.deal_id) {
        qc.invalidateQueries({ queryKey: ['meetings', ws, 'byEntity'] });
      }
    },
  });
}

export function useUpdateMeeting() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Meeting> }) => {
      const patchKeys = Object.keys(input.patch);
      const { data: fnRes, error: fnErr } = await bbInvoke<{ id: string }>(
        'crm-upsert-meeting',
        {
          workspace_id: ws,
          source: 'ui',
          substrate_entity_id: input.id,
          attrs: input.patch,
        },
      );
      if (fnErr || !fnRes?.id) throw fnErr ?? new Error('crm-upsert-meeting: update failed');
      await logActivity('meeting.updated', 'meeting', input.id, { fields: patchKeys });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
      qc.invalidateQueries({ queryKey: ['meetings', ws, 'byEntity'] });
    },
  });
}

export function useDeleteMeeting() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Substrate has no delete_entity; soft-delete via attrs.deleted_at.
      // updateEntityMerge does read-modify-write — update_entity REPLACES attrs
      // wholesale, so we cannot pass just { deleted_at } or every other attr
      // gets nuked.
      await updateEntityMerge(id, { deleted_at: new Date().toISOString() });
      await logActivity('meeting.deleted', 'meeting', id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
      qc.invalidateQueries({ queryKey: ['meetings', ws, 'byEntity'] });
    },
  });
}
