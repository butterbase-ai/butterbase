import { useState } from 'react';
import { Button } from '@/console/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { Textarea } from '@/console/components/ui/textarea';
import { Badge } from '@/console/components/ui/badge';
import { api } from '@/console/lib/api';
import { toast } from '@/console/components/ui/toast';
import type { AgentProposal } from '@/console/lib/types';

export function ProposalCard({ proposal, onChanged }: { proposal: AgentProposal; onChanged: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      await api.approveProposal({ proposal_id: proposal.id });
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await api.rejectProposal({ proposal_id: proposal.id, reason: reason || undefined });
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Reject failed');
    } finally {
      setBusy(false);
      setRejecting(false);
      setReason('');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <div className="section-label">Capability</div>
          <CardTitle className="mt-0.5">{proposal.capability}</CardTitle>
        </div>
        <Badge variant="amber">{proposal.status}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {proposal.rationale && <p className="text-sm text-muted-foreground leading-relaxed">{proposal.rationale}</p>}
        <pre className="rounded-xl border border-rule-soft bg-paper-warm p-3 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap text-foreground/85">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
        {rejecting ? (
          <div className="space-y-2">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" rows={2} />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={reject} disabled={busy}>Confirm reject</Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" onClick={approve} disabled={busy}>Approve</Button>
            <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>Reject</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
