import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Note, EntityType } from '@/lib/types';

export function useNotes(entityType: EntityType, entityId: string) {
  return useQuery({
    queryKey: qk.notes(entityType, entityId),
    queryFn: async () => {
      const { data, error } = await bb.from<Note>('notes')
        .select('*')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Note[];
    },
    enabled: !!entityId,
  });
}

export function useCreateNote() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entity_type: EntityType; entity_id: string; body: string }) => {
      const { data, error } = await bb.from<Note>('notes')
        .insert({ ...input, workspace_id: ws })
        .select();
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Note;
      await logActivity('note.created', 'note', row.id);
      return row;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: qk.notes(row.entity_type, row.entity_id) });
    },
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; entity_type: EntityType; entity_id: string }) => {
      const { error } = await bb.from('notes').delete().eq('id', input.id);
      if (error) throw error;
      await logActivity('note.deleted', 'note', input.id);
    },
    onSuccess: (_, input) => {
      qc.invalidateQueries({ queryKey: qk.notes(input.entity_type, input.entity_id) });
    },
  });
}
