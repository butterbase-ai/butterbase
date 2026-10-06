import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';

export type SyncSettings = {
  workspace_id: string;
  updated_at: string;
  google_autosync_enabled: boolean;
  notetaker_auto_enabled: boolean;
  notetaker_name: string;
};

// Defaults mirror the schema DEFAULTs — so the UI doesn't have to handle
// "no row exists yet" specially. First write upserts the row.
const DEFAULTS: Omit<SyncSettings, 'workspace_id' | 'updated_at'> = {
  google_autosync_enabled: true,
  notetaker_auto_enabled: true,
  notetaker_name: 'Notetaker',
};

export function useSyncSettings() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.syncSettings(ws ?? ''),
    queryFn: async () => {
      if (!ws) return null;
      const { data, error } = await bb.from<SyncSettings>('sync_settings')
        .select('*')
        .eq('workspace_id', ws)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? { workspace_id: ws, updated_at: new Date().toISOString(), ...DEFAULTS }) as SyncSettings;
    },
    enabled: !!ws,
  });
}

export function useUpdateSyncSettings() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Pick<SyncSettings, 'google_autosync_enabled' | 'notetaker_auto_enabled' | 'notetaker_name'>>) => {
      if (!ws) throw new Error('no workspace');
      // Routed through a function because the platform's PATCH-by-id route
      // assumes the PK column is `id`, but sync_settings is keyed by workspace_id.
      const { data, error } = await bb.functions.invoke<SyncSettings>('upsert-sync-settings', {
        body: { workspace_id: ws, ...patch },
      });
      if (error) throw error;
      return data as SyncSettings;
    },
    onSuccess: () => {
      if (ws) qc.invalidateQueries({ queryKey: qk.syncSettings(ws) });
    },
  });
}
