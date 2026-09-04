import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import type { Workspace } from '@/lib/types';

export function useWorkspaces() {
  return useQuery({
    queryKey: qk.workspaces(),
    queryFn: async () => {
      const { data, error } = await bb.from<Workspace>('workspaces').select('*');
      if (error) throw error;
      return (data ?? []) as Workspace[];
    },
  });
}
