import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { Activity } from '@/lib/types';

export function useActivities(opts?: { limit?: number; offset?: number }) {
  const ws = useCurrentWorkspaceId();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  return useQuery({
    queryKey: [...qk.activities(ws), limit, offset],
    queryFn: async () => {
      const { data, error } = await bb.from<Activity>('activities')
        .select('*')
        .eq('workspace_id', ws)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return (data ?? []) as Activity[];
    },
  });
}
