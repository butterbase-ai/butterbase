import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import type { AgentProposal } from '@/lib/types';

export function useAgentProposals(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.agentProposals(workspaceId ?? ''),
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentProposal>('agent_proposals')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
}
