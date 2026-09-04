import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import type { AgentThread } from '@/lib/types';

export function useAgentThreads(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.agentThreads(workspaceId ?? ''),
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentThread>('agent_threads')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .eq('status', 'active')
        .order('last_message_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });
}
