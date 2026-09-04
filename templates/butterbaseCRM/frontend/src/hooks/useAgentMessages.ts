import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import type { AgentMessage } from '@/lib/types';

export function useAgentMessages(threadId: string | null) {
  return useQuery({
    queryKey: qk.agentMessages(threadId ?? ''),
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentMessage>('agent_messages')
        .select('*')
        .eq('thread_id', threadId!)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}
