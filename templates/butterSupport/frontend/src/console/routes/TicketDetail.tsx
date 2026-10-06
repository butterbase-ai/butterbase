import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Lightbulb, AlertTriangle, RefreshCw, CheckCircle2, ScrollText, Sparkles, Pencil } from 'lucide-react';
import { bb } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Badge } from '@/console/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/console/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/console/components/ui/dialog';
import { Input } from '@/console/components/ui/input';
import { Textarea } from '@/console/components/ui/textarea';
import { ConversationThread } from '@/console/components/ConversationThread';
import { LiveAgentStream } from '@/console/components/LiveAgentStream';
import { DiagnosisCard } from '@/console/components/DiagnosisCard';
import { DraftReplyEditor } from '@/console/components/DraftReplyEditor';
import { ProposalCard } from '@/console/components/ProposalCard';
import { EscalationBar } from '@/console/components/EscalationBar';
import { PresenceIndicator } from '@/console/components/PresenceIndicator';
import { useTicketDoWs, useReplayedAgentEvents } from '@/console/lib/do-ws';
import type { AgentProposal, Diagnosis, Escalation, SupportMessage, SupportTicket } from '@/console/lib/types';
import { api } from '@/console/lib/api';
import { regenerateTicketSubject } from '@/console/lib/ticket-subject';
import { cn } from '@/console/lib/utils';
import { toast } from '@/console/components/ui/toast';

export function TicketDetail() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const qc = useQueryClient();

  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyTitle, setPolicyTitle] = useState('');
  const [policyContent, setPolicyContent] = useState('');
  const [policyScope, setPolicyScope] = useState('');
  const [policyRationale, setPolicyRationale] = useState('');
  const [policySubmitting, setPolicySubmitting] = useState(false);
  const [subjectEditing, setSubjectEditing] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [retitling, setRetitling] = useState(false);

  const ticketQ = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: async () => {
      const res: any = await bb.from('support_tickets').select('*').eq('id', ticketId!).limit(1);
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      return (rows[0] as SupportTicket) || null;
    },
    enabled: !!ticketId,
  });

  const messagesQ = useQuery({
    queryKey: ['messages', ticketId],
    queryFn: async () => {
      const res: any = await bb
        .from('support_messages')
        .select('*')
        .eq('ticket_id', ticketId!)
        .order('created_at', { ascending: true });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as SupportMessage[];
    },
    enabled: !!ticketId,
  });

  const diagnosesQ = useQuery({
    queryKey: ['diagnoses', ticketId],
    queryFn: async () => {
      const res: any = await bb
        .from('diagnoses')
        .select('*')
        .eq('ticket_id', ticketId!)
        .order('created_at', { ascending: false });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as Diagnosis[];
    },
    enabled: !!ticketId,
  });

  const proposalsQ = useQuery({
    queryKey: ['proposals', ticketId],
    queryFn: async () => {
      const res: any = await bb
        .from('agent_proposals')
        .select('*')
        .eq('ticket_id', ticketId!)
        .order('created_at', { ascending: false });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as AgentProposal[];
    },
    enabled: !!ticketId,
  });

  const escalationsQ = useQuery({
    queryKey: ['escalations', ticketId],
    queryFn: async () => {
      const res: any = await bb
        .from('escalations')
        .select('*')
        .eq('ticket_id', ticketId!)
        .order('created_at', { ascending: false });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as Escalation[];
    },
    enabled: !!ticketId,
  });

  // Realtime invalidation
  useEffect(() => {
    if (!ticketId) return;
    const subs: any[] = [];
    try { (bb as any).realtime?.connect?.(); } catch { /* ignore */ }
    const make = (table: string, key: any[]) => {
      try {
        subs.push(
          (bb as any).realtime?.on?.(table, { ticket_id: ticketId }, () => qc.invalidateQueries({ queryKey: key })),
        );
      } catch { /* ignore */ }
    };
    make('support_messages', ['messages', ticketId]);
    make('diagnoses', ['diagnoses', ticketId]);
    make('escalations', ['escalations', ticketId]);
    make('agent_proposals', ['proposals', ticketId]);
    return () => {
      subs.forEach((s) => { try { s?.unsubscribe?.(); } catch { /* ignore */ } });
    };
  }, [ticketId, qc]);

  const do_ = useTicketDoWs(ticketId);
  const readonly = do_.readonly;
  const readonlyReason = do_.readonlyReason;
  // Replay persisted trace (auto-replies + past founder-driven runs). Merged
  // before live so refresh / teammates see what happened.
  const replayedEvents = useReplayedAgentEvents(ticketId);
  const mergedAgentEvents = useMemo(() => [...replayedEvents, ...do_.events], [replayedEvents, do_.events]);

  // Auto-generate a subject the first time we open a ticket that doesn't have
  // one. Runs once per ticket per page load; failures are swallowed so the
  // ticket header just keeps showing "(no subject)". The Retitle action for
  // re-runs lives on each row's 3-dots menu in the inbox list.
  const subjectAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ticketId) return;
    if (subjectAttemptedRef.current === ticketId) return;
    const ticket = ticketQ.data;
    const hasCustomerMsg = (messagesQ.data || []).some((m) => m.role === 'customer');
    if (!ticket || ticket.subject || !hasCustomerMsg) return;
    subjectAttemptedRef.current = ticketId;
    regenerateTicketSubject(ticketId)
      .then((subject) => {
        if (subject) {
          qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
          qc.invalidateQueries({ queryKey: ['tickets'] });
        }
      })
      .catch(() => {
        // ignore — leave subject blank
      });
  }, [ticketId, ticketQ.data, messagesQ.data, qc]);

  const latestDiagnosis = useMemo(() => {
    return diagnosesQ.data?.find((d) => !d.superseded_at) ?? diagnosesQ.data?.[0] ?? null;
  }, [diagnosesQ.data]);

  const messages = messagesQ.data || [];
  const draft = useMemo(() => {
    const lastFounderIdx = [...messages].reverse().findIndex((m) => m.role === 'founder');
    const lastFounderAt = lastFounderIdx === -1 ? null : messages[messages.length - 1 - lastFounderIdx].created_at;
    const draftMsg = [...messages].reverse().find((m) => m.role === 'agent_draft');
    if (!draftMsg) return null;
    if (lastFounderAt && draftMsg.created_at < lastFounderAt) return null;
    return draftMsg;
  }, [messages]);

  const pendingProposals = (proposalsQ.data || []).filter((p) => p.status === 'pending');
  const openEscalation = (escalationsQ.data || []).find((e) => e.status === 'queued' || e.status === 'failed') ?? null;

  if (!ticketId) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule-soft px-7 py-4 flex items-center gap-4">
        <Link
          to="/inbox"
          className="grid h-8 w-8 place-items-center rounded-full border border-rule text-muted-foreground hover:border-butter-300/60 hover:text-caramel transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="section-label mb-0.5">Ticket · {ticketId.slice(0, 8)}</div>
          <div className="flex items-center gap-2 min-w-0">
            {subjectEditing ? (
              <input
                autoFocus
                value={subjectDraft}
                onChange={(e) => setSubjectDraft(e.target.value)}
                onBlur={async () => {
                  const next = subjectDraft.trim();
                  setSubjectEditing(false);
                  if (!next || next === (ticketQ.data?.subject || '')) return;
                  try {
                    await bb.from('support_tickets').update({ subject: next.slice(0, 200) }).eq('id', ticketId);
                    qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
                    qc.invalidateQueries({ queryKey: ['tickets'] });
                  } catch (err: any) {
                    toast.error(err?.message || 'Failed to save subject');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setSubjectEditing(false); setSubjectDraft(ticketQ.data?.subject || ''); }
                }}
                className="font-display text-xl tracking-tight text-foreground bg-transparent border border-butter-300/60 rounded-md px-2 py-0.5 flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-butter-300/40"
                placeholder="Ticket subject"
                maxLength={200}
              />
            ) : (
              <button
                type="button"
                onClick={() => { setSubjectDraft(ticketQ.data?.subject || ''); setSubjectEditing(true); }}
                className="font-display text-xl tracking-tight truncate text-foreground text-left hover:text-caramel transition-colors min-w-0"
                title="Click to edit subject"
              >
                {ticketQ.data?.subject || <span className="italic text-muted-foreground">(no subject)</span>}
              </button>
            )}
            {!subjectEditing && (
              <button
                type="button"
                onClick={() => { setSubjectDraft(ticketQ.data?.subject || ''); setSubjectEditing(true); }}
                className="rounded-full p-1 text-muted-foreground/60 hover:bg-paper-warm hover:text-foreground transition-colors shrink-0"
                title="Edit subject"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {!subjectEditing && (
              <button
                type="button"
                disabled={retitling}
                onClick={async () => {
                  setRetitling(true);
                  try {
                    const next = await regenerateTicketSubject(ticketId);
                    if (next) {
                      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
                      qc.invalidateQueries({ queryKey: ['tickets'] });
                      toast.success(next, { title: 'Retitled' });
                    } else {
                      toast.info('No subject generated — is there a customer message on this ticket?');
                    }
                  } catch (err: any) {
                    toast.error(err?.message || 'Retitle failed');
                  } finally {
                    setRetitling(false);
                  }
                }}
                className="rounded-full p-1 text-muted-foreground/60 hover:bg-paper-warm hover:text-caramel transition-colors shrink-0 disabled:opacity-50"
                title="Regenerate subject with AI"
              >
                <Sparkles className={cn('h-3 w-3', retitling && 'animate-spin')} />
              </button>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground truncate">
            {ticketQ.data?.customer_name
              ? ticketQ.data.customer_email
                ? `${ticketQ.data.customer_name} · ${ticketQ.data.customer_email}`
                : ticketQ.data.customer_name
              : ticketQ.data?.customer_email || 'Anonymous visitor'}
          </div>
        </div>
        <PresenceIndicator ticketId={ticketId} />
        {ticketQ.data?.status && <Badge>{ticketQ.data.status.replace(/_/g, ' ')}</Badge>}
        <button
          className="text-xs text-muted-foreground inline-flex items-center gap-1.5 hover:text-caramel transition-colors"
          onClick={() => toast.info('Widget link not yet wired (v1 TODO)')}
        >
          <ExternalLink className="h-3 w-3" /> Open in widget
        </button>
      </div>

      {openEscalation && <EscalationBar escalation={openEscalation} />}

      {readonly && (
        <div className="border-b border-butter-300/60 bg-butter-50 px-7 py-2.5 text-xs text-caramel-deep">
          <span className="font-mono uppercase tracking-[0.18em] text-caramel mr-2">read-only</span>
          {readonlyReason === 'not_authenticated'
            ? 'Sign in to drive this ticket. Showing live state only.'
            : 'This ticket is being driven by another user. State refreshes via Postgres realtime.'}
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-rule-soft bg-paper-warm px-7 py-2.5">
        <Button size="sm" variant="outline" onClick={() => do_.send({ cmd: 'diagnose' })} disabled={readonly}>
          <Lightbulb className="h-3.5 w-3.5" /> Diagnose
        </Button>
        {import.meta.env.VITE_ENABLE_RERUN_WITH_HINT === 'true' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const hint = window.prompt('Hint for the agent:');
              if (hint) do_.send({ cmd: 'rerun_with_hint', hint });
            }}
            disabled={readonly}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Rerun with hint
          </Button>
        )}
        {import.meta.env.VITE_ENABLE_MANUAL_ESCALATE === 'true' && (
          <Button
            size="sm"
            variant="crust"
            onClick={() => {
              const reason = window.prompt('Escalation reason?');
              if (reason) do_.send({ cmd: 'escalate', reason });
            }}
            disabled={readonly}
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Escalate
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          onClick={async () => {
            try {
              await bb.from('support_tickets').update({ status: 'resolved' }).eq('id', ticketId);
              qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
              qc.invalidateQueries({ queryKey: ['tickets'] });
              toast.success('Ticket resolved');
            } catch (e: any) {
              toast.error(e?.message || 'Failed to resolve');
            }
          }}
          disabled={readonly || ticketQ.data?.status === 'resolved'}
          title={ticketQ.data?.status === 'resolved' ? 'Already resolved' : undefined}
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> {ticketQ.data?.status === 'resolved' ? 'Resolved' : 'Resolve'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPolicyTitle(ticketQ.data?.subject ? `Policy: ${ticketQ.data.subject}` : '');
            setPolicyContent('');
            setPolicyScope('');
            setPolicyRationale('');
            setPolicyOpen(true);
          }}
          disabled={readonly}
          title="Promote this ticket's resolution into a reusable policy stored in substrate"
        >
          <ScrollText className="h-3.5 w-3.5" /> Convert to policy
        </Button>
        <div className="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              do_.connected ? 'bg-positive shadow-[0_0_8px_rgba(127,176,105,0.7)] animate-pulse-soft' : 'bg-muted-foreground/50',
            )}
          />
          DO · {do_.connected ? 'live' : 'offline'} · {do_.state}
        </div>
      </div>

      <div className="grid flex-1 min-h-0 grid-cols-[3fr_2fr]">
        <div className="flex min-h-0 flex-col border-r border-rule-soft">
          <div className="flex-1 overflow-y-auto">
            <ConversationThread messages={messages} ticketId={ticketId} />
          </div>
          <DraftReplyEditor
            ticketId={ticketId}
            draft={draft}
            onSent={() => {
              qc.invalidateQueries({ queryKey: ['messages', ticketId] });
              qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
            }}
            readonly={readonly}
          />
        </div>
        <div className="flex min-h-0 flex-col bg-paper-warm">
          <Tabs defaultValue="activity" className="flex h-full min-h-0 flex-col">
            <div className="px-5 pt-4">
              <TabsList>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="diagnosis">Diagnosis</TabsTrigger>
                <TabsTrigger value="customer">Customer</TabsTrigger>
                <TabsTrigger value="proposals">
                  Proposals{pendingProposals.length ? ` · ${pendingProposals.length}` : ''}
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="flex-1 overflow-y-auto">
              <TabsContent value="activity">
                <LiveAgentStream events={mergedAgentEvents} />
              </TabsContent>
              <TabsContent value="diagnosis">
                <DiagnosisCard
                  diagnosis={latestDiagnosis}
                  onRerun={(hint) => do_.send({ cmd: 'rerun_with_hint', hint })}
                  readonly={readonly}
                />
              </TabsContent>
              <TabsContent value="customer">
                <CustomerCard email={ticketQ.data?.customer_email} />
              </TabsContent>
              <TabsContent value="proposals">
                <div className="p-5 space-y-3">
                  {(proposalsQ.data || []).length === 0 ? (
                    <div className="text-sm text-muted-foreground">No proposals yet.</div>
                  ) : (
                    (proposalsQ.data || []).map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={p}
                        onChanged={() => qc.invalidateQueries({ queryKey: ['proposals', ticketId] })}
                      />
                    ))
                  )}
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert ticket to policy</DialogTitle>
            <DialogDescription>
              Promote this resolution into a reusable policy. Recorded in substrate as a <code>policy_decision</code> so future agents and teammates can reference it. Admin/owner only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input
                value={policyTitle}
                onChange={(e) => setPolicyTitle(e.target.value)}
                placeholder="e.g. Refund policy for accidental duplicate charges"
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Policy text</label>
              <Textarea
                value={policyContent}
                onChange={(e) => setPolicyContent(e.target.value)}
                placeholder="The exact policy. Plain language. Future agents will read this."
                rows={6}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Scope (optional)</label>
                <Input
                  value={policyScope}
                  onChange={(e) => setPolicyScope(e.target.value)}
                  placeholder="e.g. billing, EU customers"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Rationale (optional)</label>
                <Input
                  value={policyRationale}
                  onChange={(e) => setPolicyRationale(e.target.value)}
                  placeholder="Why this policy exists"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setPolicyOpen(false)} disabled={policySubmitting}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={policySubmitting || !policyTitle.trim() || !policyContent.trim()}
                onClick={async () => {
                  setPolicySubmitting(true);
                  try {
                    await api.convertToPolicy({
                      title: policyTitle.trim(),
                      content: policyContent.trim(),
                      scope: policyScope.trim() || undefined,
                      rationale: policyRationale.trim() || undefined,
                      source_ticket_id: ticketId,
                    });
                    toast.success('Policy recorded to substrate');
                    setPolicyOpen(false);
                  } catch (e: any) {
                    const msg = e?.message || 'Failed to record policy';
                    toast.error(msg.includes('forbidden') ? 'Admins only — your account does not have permission' : msg);
                  } finally {
                    setPolicySubmitting(false);
                  }
                }}
              >
                {policySubmitting ? 'Recording…' : 'Record policy'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CustomerCard({ email }: { email?: string | null }) {
  const q = useQuery({
    queryKey: ['substrate-entity', email],
    queryFn: async () => {
      if (!email) return null;
      try {
        return await api.substrateProxy({ action: 'findEntities', params: { type: 'customer', email } });
      } catch (e: any) {
        return { error: e?.message || 'lookup failed' };
      }
    },
    enabled: !!email,
  });
  if (!email) return <div className="p-5 text-sm text-muted-foreground">No customer email on this ticket.</div>;
  return (
    <div className="p-5 space-y-4 text-sm">
      <div>
        <div className="section-label mb-1.5">Email</div>
        <div className="font-mono text-foreground/90">{email}</div>
      </div>
      <div>
        <div className="section-label mb-1.5">Substrate entity</div>
        {q.isLoading ? (
          <div className="font-mono text-[11px] text-muted-foreground">Loading…</div>
        ) : (
          <pre className="max-h-80 overflow-auto rounded-xl border border-rule-soft bg-paper-warm p-3 font-mono text-[11px] whitespace-pre-wrap text-foreground/80">
            {JSON.stringify(q.data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
