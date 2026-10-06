import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { Attachment, EntityType } from '@/lib/types';

export function useAttachments(entityType: EntityType, entityId: string) {
  return useQuery({
    queryKey: qk.attachments(entityType, entityId),
    queryFn: async () => {
      const { data, error } = await bb.from<Attachment>('attachments')
        .select('*')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Attachment[];
    },
    enabled: !!entityId,
  });
}

export function useCreateAttachment() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      entity_type: EntityType;
      entity_id: string;
      object_id: string;
      filename: string;
      content_type?: string | null;
      size_bytes?: number | null;
    }) => {
      const { data, error } = await bb.from<Attachment>('attachments')
        .insert({ ...input, workspace_id: ws })
        .select();
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Attachment;
      return row;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: qk.attachments(row.entity_type, row.entity_id) });
    },
  });
}

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; entity_type: EntityType; entity_id: string }) => {
      const { error } = await bb.from('attachments').delete().eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: (_, input) => {
      qc.invalidateQueries({ queryKey: qk.attachments(input.entity_type, input.entity_id) });
    },
  });
}
