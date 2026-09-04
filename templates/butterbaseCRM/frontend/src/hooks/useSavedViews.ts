import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { SavedView, ObjectTypeSlug } from '@/lib/types';

export function useSavedViews(objectType: ObjectTypeSlug) {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.savedViews(ws, objectType),
    queryFn: async () => {
      const { data, error } = await bb.from<SavedView>('saved_views')
        .select('*')
        .eq('workspace_id', ws)
        .eq('object_type', objectType)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SavedView[];
    },
    enabled: !!ws,
  });
}

export function useCreateSavedView() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<SavedView, 'id' | 'workspace_id' | 'created_by' | 'created_at' | 'updated_at'> & { created_by: string }) => {
      const { data, error } = await bb.from<SavedView>('saved_views')
        .insert({ ...input, workspace_id: ws })
        .select();
      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as SavedView;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: qk.savedViews(ws, row.object_type) });
    },
  });
}

export function useUpdateSavedView() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<SavedView> }) => {
      const { error } = await bb.from('saved_views').update(input.patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['savedViews', ws] }),
  });
}

export function useDeleteSavedView() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('saved_views').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['savedViews', ws] }),
  });
}
