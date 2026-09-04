import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, Sparkles, Check, X, Mail, Calendar } from 'lucide-react';
import { format } from 'date-fns';
import { bb } from '@/lib/butterbase';
import { useCurrentWorkspaceId } from '@/lib/workspace';

interface DealProposal {
  id: string;
  workspace_id: string;
  suggested_name: string;
  company_id: string | null;
  person_id: string | null;
  suggested_amount_cents: number | null;
  suggested_stage: string | null;
  source_kind: 'email' | 'meeting' | null;
  source_entity_id: string | null;
  ai_reasoning: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  created_deal_id: string | null;
  created_at: string;
}

function useProposals(workspaceId: string) {
  return useQuery({
    queryKey: ['deal_proposals', workspaceId],
    queryFn: async (): Promise<DealProposal[]> => {
      const { data, error } = await bb
        .from<DealProposal>('deal_proposals')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function useScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await bb.functions.invoke('propose-deals', {
        body: { workspace_id: workspaceId },
      });
      if (error) throw error;
      return data as { scanned: { emails: number; meetings: number }; proposals_inserted: number };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal_proposals', workspaceId] }),
  });
}

function useAccept(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proposalId: string) => {
      const { error } = await bb.functions.invoke('accept-deal-proposal', {
        body: { proposal_id: proposalId },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deal_proposals', workspaceId] });
      qc.invalidateQueries({ queryKey: ['deals', workspaceId] });
    },
  });
}

function useReject(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proposalId: string) => {
      const { data: me } = await bb.auth.getUser();
      const uid = (me as any)?.id;
      const { error } = await bb
        .from('deal_proposals')
        .update({ status: 'rejected', decided_by: uid, decided_at: new Date().toISOString() })
        .eq('id', proposalId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal_proposals', workspaceId] }),
  });
}

export default function Inbox() {
  const ws = useCurrentWorkspaceId();
  const { data: proposals = [], isLoading } = useProposals(ws);
  const scan = useScan(ws);
  const accept = useAccept(ws);
  const reject = useReject(ws);

  const pending = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending');

  async function handleScan() {
    try {
      const r = await scan.mutateAsync();
      if (r.proposals_inserted === 0) {
        toast.success('Scan complete', {
          description: `Looked at ${r.scanned.emails} emails + ${r.scanned.meetings} meetings — nothing deal-shaped.`,
        });
      } else {
        toast.success(`+${r.proposals_inserted} proposal${r.proposals_inserted === 1 ? '' : 's'}`, {
          description: `Scanned ${r.scanned.emails} emails + ${r.scanned.meetings} meetings.`,
        });
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Scan failed');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 06 · Inbox</p>
          <h1 className="page-title">
            Deal <em>proposals</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            The AI watches your inbox + calendar and flags conversations that look like opportunities. Approve or skip — nothing lands as a deal without your nod.
          </p>
        </div>
        <Button
          onClick={handleScan}
          disabled={scan.isPending}
          className="gap-2 bg-foreground text-background hover:bg-foreground/85"
        >
          {scan.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Scan now
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-8 py-8 space-y-10">
          <section>
            <div className="flex items-baseline gap-3 mb-4">
              <p className="eyebrow">Pending · {pending.length}</p>
              <span className="h-px flex-1 bg-border" />
            </div>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            ) : pending.length === 0 ? (
              <p className="font-editorial italic text-muted-foreground">
                — no pending proposals. Click <span className="font-mono not-italic">Scan now</span> to look at your recent activity. —
              </p>
            ) : (
              <ul className="space-y-2">
                {pending.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    busyAccept={accept.isPending}
                    busyReject={reject.isPending}
                    onAccept={() =>
                      accept.mutate(p.id, {
                        onSuccess: () => toast.success('Deal created'),
                        onError: (e) => toast.error(e instanceof Error ? e.message : 'Accept failed'),
                      })
                    }
                    onReject={() =>
                      reject.mutate(p.id, {
                        onSuccess: () => toast.success('Skipped'),
                        onError: (e) => toast.error(e instanceof Error ? e.message : 'Reject failed'),
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          {decided.length > 0 && (
            <section>
              <div className="flex items-baseline gap-3 mb-4">
                <p className="eyebrow">Recent · {decided.length}</p>
                <span className="h-px flex-1 bg-border" />
              </div>
              <ul className="space-y-2">
                {decided.slice(0, 20).map((p) => (
                  <ProposalCard key={p.id} proposal={p} decided />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  decided,
  busyAccept,
  busyReject,
  onAccept,
  onReject,
}: {
  proposal: DealProposal;
  decided?: boolean;
  busyAccept?: boolean;
  busyReject?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}) {
  const Source = proposal.source_kind === 'email' ? Mail : Calendar;
  return (
    <li className="card-flat px-5 py-4 flex items-start gap-4">
      <div className="grid place-items-center h-9 w-9 rounded-md bg-background border border-border shrink-0">
        <Source className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-display text-[16px] tracking-tight text-foreground">
            {proposal.suggested_name}
          </p>
          {proposal.suggested_stage && (
            <span className="stage-pill">{proposal.suggested_stage}</span>
          )}
          {decided && (
            <span className={`stage-pill ${proposal.status === 'accepted' ? '!bg-sage/15 !text-sage' : '!bg-muted text-muted-foreground'}`}>
              {proposal.status}
            </span>
          )}
        </div>
        {proposal.ai_reasoning && (
          <p className="mt-1 font-editorial italic text-[13px] text-muted-foreground">
            {proposal.ai_reasoning}
          </p>
        )}
        <p className="mt-1.5 font-mono text-[11px] text-muted-foreground num">
          {proposal.source_kind} · {format(new Date(proposal.created_at), 'MMM d, h:mm a')}
        </p>
      </div>
      {!decided && (
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={busyReject || busyAccept}
            className="gap-1.5 border-coral/30 text-coral hover:bg-coral/10"
          >
            <X className="h-3 w-3" />
            Skip
          </Button>
          <Button
            size="sm"
            onClick={onAccept}
            disabled={busyAccept || busyReject}
            className="gap-1.5 bg-foreground text-background hover:bg-foreground/85"
          >
            {busyAccept ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Create deal
          </Button>
        </div>
      )}
    </li>
  );
}
