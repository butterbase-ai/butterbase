import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import type { Membership } from '@/lib/types';

export function useMemberships(workspaceId?: string) {
  return useQuery({
    queryKey: qk.memberships(workspaceId),
    queryFn: async () => {
      let query = bb.from<Membership>('memberships').select('*');
      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Membership[];
    },
  });
}
