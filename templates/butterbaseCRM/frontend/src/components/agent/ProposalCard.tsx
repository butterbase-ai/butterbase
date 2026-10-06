import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { bb } from '@/lib/butterbase';
import { PROPOSAL_ENDPOINTS } from '@/lib/agent';
import type { AgentProposal } from '@/lib/types';

function useCurrentUserId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    bb.auth.getUser().then((r: any) => {
      const u = r?.data?.user ?? r?.data;
      setId(u?.id ?? null);
    });
  }, []);
  return id;
}

function labelForTool(name: string): string {
  switch (name) {
    case 'propose_create_company':    return 'Create company';
    case 'propose_create_person':     return 'Create person';
    case 'propose_create_deal':       return 'Create deal';
    case 'propose_update_deal_stage': return 'Update deal stage';
    case 'propose_add_note':          return 'Add note';
    case 'propose_invite_member':     return 'Invite member';
    default:                          return name;
  }
}

interface Props {
  proposal: AgentProposal;
  onResolved?: (status: 'approved' | 'rejected') => void;
}

export function ProposalCard({ proposal, onResolved }: Props) {
  const [payload, setPayload] = useState<Record<string, any>>(proposal.payload ?? {});
  const [status, setStatus] = useState(proposal.status);
  const [busy, setBusy] = useState(false);
  const userId = useCurrentUserId();

  // Resync if the underlying proposal changes (realtime update from another tab).
  useEffect(() => { setStatus(proposal.status); setPayload(proposal.payload ?? {}); }, [proposal.status, proposal.payload]);

  const expired = status === 'pending' && new Date(proposal.expires_at).getTime() < Date.now();
  const fields = Object.entries(payload).filter(([, v]) => typeof v === 'string' || typeof v === 'number');

  async function approve() {
    const endpoint = PROPOSAL_ENDPOINTS[proposal.tool_name];
    if (!endpoint || !userId) { toast.error('Unsupported proposal type'); return; }
    setBusy(true);
    try {
      // 1) Mark approved (with guard against already-resolved).
      const upd = await bb.from('agent_proposals' as any)
        .update({ status: 'approved', resolution: { edited_payload: payload }, resolved_at: new Date().toISOString() } as any)
        .eq('id', proposal.id);
      if (upd.error) throw upd.error;
      // The guard against "already approved by another tab" is best-effort here —
      // RLS UPDATE on agent_proposals requires status='pending' so a stale tab's
      // update simply affects 0 rows. We rely on the realtime refresh to correct UI.

      // 2) Execute the real write.
      const body = endpoint.buildBody(payload, proposal.workspace_id, userId);
      let createdId: string | null = null;
      if (endpoint.method === 'INVOKE_FN') {
        const { data, error } = await (bb.functions as any).invoke(endpoint.path, { body });
        if (error) throw error;
        createdId = (data as any)?.id ?? null;
      } else if (endpoint.method === 'POST') {
        const { data, error } = await bb.from(endpoint.path as any).insert(body as any).select();
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        createdId = (row as any)?.id ?? null;
      } else if (endpoint.method === 'PATCH') {
        // For now, only propose_update_deal_stage uses PATCH — body has `stage`, payload has `deal_id`.
        const dealId = (payload as any)?.deal_id;
        if (!dealId) throw new Error('missing_deal_id');
        const { error } = await bb.from(endpoint.path as any).update(body as any).eq('id', dealId);
        if (error) throw error;
        createdId = dealId;
      }

      // 3) Persist resolution.created_id.
      if (createdId) {
        await bb.from('agent_proposals' as any)
          .update({ resolution: { edited_payload: payload, created_id: createdId } } as any)
          .eq('id', proposal.id);
      }

      setStatus('approved');
      onResolved?.('approved');
      toast.success('Approved');
    } catch (e: any) {
      // Revert on failure.
      try {
        await bb.from('agent_proposals' as any)
          .update({ status: 'pending', resolution: null, resolved_at: null } as any)
          .eq('id', proposal.id);
      } catch { /* */ }
      setStatus('pending');
      toast.error(e?.message ?? 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const { error } = await bb.from('agent_proposals' as any)
        .update({ status: 'rejected', resolution: { reason: 'user_rejected' }, resolved_at: new Date().toISOString() } as any)
        .eq('id', proposal.id);
      if (error) throw error;
      setStatus('rejected');
      onResolved?.('rejected');
    } catch (e: any) {
      toast.error(e?.message ?? 'Reject failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2.5">
      {proposal.rationale && (
        <p className="font-editorial italic text-[12px] text-muted-foreground">{proposal.rationale}</p>
      )}
      <p className="text-[13.5px] font-medium">{labelForTool(proposal.tool_name)}</p>
      <div className="space-y-1.5">
        {fields.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[12.5px]">
            <label className="w-24 shrink-0 text-muted-foreground">{k}</label>
            <input
              value={String(v ?? '')}
              onChange={(e) => setPayload({ ...payload, [k]: e.target.value })}
              disabled={status !== 'pending' || busy}
              className="flex-1 h-7 rounded border border-input bg-transparent px-2"
            />
          </div>
        ))}
        {fields.length === 0 && (
          <p className="text-[12px] text-muted-foreground font-mono">No editable fields.</p>
        )}
      </div>
      {status === 'pending' && !expired && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={reject} disabled={busy}>Reject</Button>
          <Button size="sm" onClick={approve} disabled={busy || !userId}>{busy ? 'Working…' : 'Approve'}</Button>
        </div>
      )}
      {status === 'approved' && <p className="text-[12px] text-emerald-600">Approved ✓</p>}
      {status === 'rejected' && <p className="text-[12px] text-muted-foreground">Rejected</p>}
      {(status === 'expired' || (status === 'pending' && expired)) && (
        <p className="text-[12px] text-muted-foreground">Expired — ask the agent again.</p>
      )}
    </div>
  );
}
