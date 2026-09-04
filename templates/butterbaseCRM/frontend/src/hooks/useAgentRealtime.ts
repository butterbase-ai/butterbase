import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useHasBbSession } from '@/lib/realtime';

export function useAgentRealtime(threadId: string | null, workspaceId: string | null) {
  const qc = useQueryClient();
  const hasSession = useHasBbSession();

  useEffect(() => {
    if (!workspaceId || !hasSession) return;
    bb.realtime.connect();
    const sub = bb.realtime.on('agent_proposals', (change: any) => {
      const rec = (change.record ?? change.old_record) as { workspace_id?: string } | null;
      if (rec?.workspace_id === workspaceId) {
        qc.invalidateQueries({ queryKey: qk.agentProposals(workspaceId) });
      }
    });
    return () => sub.unsubscribe();
  }, [workspaceId, qc, hasSession]);

  useEffect(() => {
    if (!threadId || !hasSession) return;
    bb.realtime.connect();
    const sub = bb.realtime.on('agent_messages', (change: any) => {
      const rec = (change.record ?? change.old_record) as { thread_id?: string } | null;
      if (rec?.thread_id === threadId) {
        qc.invalidateQueries({ queryKey: qk.agentMessages(threadId) });
      }
    });
    return () => sub.unsubscribe();
  }, [threadId, qc, hasSession]);
}
