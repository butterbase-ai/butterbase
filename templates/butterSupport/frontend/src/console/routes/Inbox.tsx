import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { TicketList } from '@/console/components/TicketList';
import { PatternBanner } from '@/console/components/PatternBanner';
import type { PatternSignal, SupportTicket, TicketStatus } from '@/console/lib/types';
import { cn } from '@/console/lib/utils';
import { Inbox as InboxIcon } from 'lucide-react';
import { toast } from '@/console/components/ui/toast';

const PATTERN_THRESHOLD = 3;

const FILTERS: { label: string; value: TicketStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Open', value: 'open' },
  { label: 'Awaiting approval', value: 'awaiting_approval' },
  { label: 'Escalated', value: 'escalated' },
  { label: 'Resolved', value: 'resolved' },
];

export function Inbox() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<TicketStatus | 'all'>('all');

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['tickets', filter],
    queryFn: async () => {
      let q: any = bb.from('support_tickets').select('*').order('last_message_at', { ascending: false }).limit(200);
      if (filter !== 'all') q = q.eq('status', filter);
      const res: any = await q;
      const rows: SupportTicket[] = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as SupportTicket[];
      try {
        const propRes: any = await bb.from('agent_proposals').select('ticket_id,status').eq('status', 'pending');
        const props: any[] = Array.isArray(propRes?.data) ? propRes.data : Array.isArray(propRes) ? propRes : [];
        const counts = props.reduce<Record<string, number>>((acc, p) => {
          acc[p.ticket_id] = (acc[p.ticket_id] || 0) + 1;
          return acc;
        }, {});
        return rows.map((r) => ({ ...r, pending_proposal_count: counts[r.id] || 0 }));
      } catch {
        return rows;
      }
    },
  });

  const { data: topPattern } = useQuery({
    queryKey: ['pattern_signals', 'banner', PATTERN_THRESHOLD],
    queryFn: async () => {
      try {
        const res: any = await bb
          .from('pattern_signals')
          .select('*')
          .eq('surfaced', false)
          .gte('count', PATTERN_THRESHOLD)
          .order('count', { ascending: false })
          .limit(1);
        const rows = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as PatternSignal[];
        return rows[0] || null;
      } catch {
        return null;
      }
    },
    refetchOnWindowFocus: false,
  });

  async function dismissPattern(id: string) {
    try {
      await bb
        .from('pattern_signals')
        .update({ surfaced: true, surfaced_at: new Date().toISOString() })
        .eq('id', id);
      qc.invalidateQueries({ queryKey: ['pattern_signals'] });
    } catch (e: any) {
      toast.error(e?.message || 'Dismiss failed');
    }
  }

  useEffect(() => {
    const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets'] });
    let s1: any, s2: any, s3: any;
    try { (bb as any).realtime?.connect?.(); } catch { /* ignore */ }
    try { s1 = (bb as any).realtime?.on?.('support_tickets', invalidate); } catch { /* ignore */ }
    try { s2 = (bb as any).realtime?.on?.('agent_proposals', invalidate); } catch { /* ignore */ }
    // New customer messages arrive via widget-ingest / widget-followup as INSERTs
    // on support_messages. Without this subscription the inbox stays stale until
    // a page refresh because support_tickets is only touched on state changes
    // (e.g. status flip) — a plain follow-up doesn't rewrite the ticket row.
    try { s3 = (bb as any).realtime?.on?.('support_messages', invalidate); } catch { /* ignore */ }
    return () => {
      try { s1?.unsubscribe?.(); } catch { /* ignore */ }
      try { s2?.unsubscribe?.(); } catch { /* ignore */ }
      try { s3?.unsubscribe?.(); } catch { /* ignore */ }
    };
  }, [qc]);

  const NEEDS_ATTENTION: TicketStatus[] = ['open', 'awaiting_approval', 'escalated'];
  const totalOpen = tickets.filter((t) => NEEDS_ATTENTION.includes(t.status)).length;

  return (
    <div className="flex h-full flex-col">
      {topPattern && (
        <PatternBanner pattern={topPattern} onDismiss={() => dismissPattern(topPattern.id)} />
      )}
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Inbox</p>
          <h1 className="page-title">
            Tickets <em>in flight</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            {tickets.length} tickets · {totalOpen} need attention
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'h-8 rounded-md border px-3 text-[12.5px] transition-colors',
                filter === f.value
                  ? 'bg-foreground text-background border-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-butter animate-pulse-soft" />
            <span className="eyebrow !text-[10px]">loading tickets…</span>
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center max-w-sm">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-md border border-border bg-card">
                <InboxIcon className="h-5 w-5 text-butter" strokeWidth={1.75} />
              </div>
              <p className="eyebrow mb-3">Empty for now</p>
              <p className="font-display text-[26px] leading-tight tracking-tight">
                The inbox is <em className="font-editorial italic text-butter">quiet</em>.
              </p>
              <p className="mt-3 font-editorial italic text-[14px] text-muted-foreground">
                Once the widget receives a message, it'll appear here.
              </p>
            </div>
          </div>
        ) : (
          <TicketList tickets={tickets} />
        )}
      </div>
    </div>
  );
}
