import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Sparkles, ChevronRight } from 'lucide-react';
import { Badge } from '@/console/components/ui/badge';
import { cn, timeAgo } from '@/console/lib/utils';
import { regenerateTicketSubject } from '@/console/lib/ticket-subject';
import { toast } from '@/console/components/ui/toast';
import type { SupportTicket, TicketStatus } from '@/console/lib/types';

const statusVariant: Record<TicketStatus, 'default' | 'amber' | 'red' | 'green' | 'secondary' | 'outline'> = {
  open: 'default',
  pending_agent: 'secondary',
  awaiting_approval: 'amber',
  awaiting_customer: 'outline',
  escalated: 'red',
  resolved: 'green',
  closed: 'secondary',
};

function TicketRowMenu({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="Ticket options"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded-full p-1.5 text-muted-foreground hover:bg-paper-warm hover:text-foreground transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-52 rounded-xl border border-rule bg-paper-soft py-1 text-sm shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]">
          <button
            type="button"
            disabled={busy}
            onClick={async (e) => {
              e.stopPropagation();
              setBusy(true);
              try {
                const subject = await regenerateTicketSubject(ticketId);
                if (subject) {
                  qc.invalidateQueries({ queryKey: ['tickets'] });
                  qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
                }
              } catch (err: any) {
                toast.error(err?.message || 'Failed to retitle');
              } finally {
                setBusy(false);
                setOpen(false);
              }
            }}
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-foreground/90 hover:bg-butter-100 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5 text-caramel" />
            {busy ? 'Retitling…' : 'Retitle with AI'}
          </button>
        </div>
      )}
    </div>
  );
}

export function TicketList({ tickets }: { tickets: SupportTicket[] }) {
  const navigate = useNavigate();
  if (tickets.length === 0) return null;
  return (
    <div className="px-8 py-6 space-y-2">
      {tickets.map((t) => (
        <div
          key={t.id}
          onClick={() => navigate(`/inbox/${t.id}`)}
          className={cn(
            'group relative grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 rounded-2xl border border-rule-soft bg-paper-soft px-5 py-4 cursor-pointer transition-all duration-200',
            'hover:border-butter-300/60 hover:bg-paper-soft hover:shadow-[0_0_40px_-15px_rgba(245,200,66,0.35)]',
          )}
        >
          <div className="flex items-center gap-3">
            <Badge variant={statusVariant[t.status] ?? 'default'}>
              {t.status.replace(/_/g, ' ')}
            </Badge>
          </div>

          <div className="min-w-0">
            <div className="text-sm font-medium truncate text-foreground group-hover:text-caramel-deep transition-colors">
              {t.subject || <span className="italic text-muted-foreground">(no subject)</span>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground truncate">
              {t.customer_name
                ? t.customer_email ? `${t.customer_name} · ${t.customer_email}` : t.customer_name
                : t.customer_email || 'Anonymous visitor'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(t.pending_proposal_count ?? 0) > 0 && (
              <Badge variant="amber">{t.pending_proposal_count} pending</Badge>
            )}
            {t.priority && t.priority !== 'normal' && (
              <Badge variant="outline">{t.priority}</Badge>
            )}
          </div>

          <div className="font-mono text-[11px] text-muted-foreground w-28 text-right tabular-nums">
            {timeAgo(t.last_message_at)}
          </div>

          <div className="flex items-center gap-1">
            <TicketRowMenu ticketId={t.id} />
            <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-caramel group-hover:translate-x-0.5 transition-all" />
          </div>
        </div>
      ))}
    </div>
  );
}
