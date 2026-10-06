import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { Badge } from '@/console/components/ui/badge';
import type { PatternSignal, SupportTicket } from '@/console/lib/types';
import { timeAgo } from '@/console/lib/utils';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';

function PatternTickets({ ids }: { ids: string[] }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['pattern_sample_tickets', ids.join(',')],
    queryFn: async () => {
      const res: any = await bb
        .from('support_tickets')
        .select('id,subject,customer_name,customer_email,status,last_message_at,channel')
        .in('id', ids);
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as SupportTicket[];
    },
    enabled: ids.length > 0,
  });

  if (isLoading) {
    return (
      <div className="mt-3 font-mono text-[11px] text-muted-foreground">loading tickets…</div>
    );
  }
  if (data.length === 0) {
    return (
      <div className="mt-3 font-mono text-[11px] text-muted-foreground">no tickets found</div>
    );
  }
  return (
    <ul className="mt-3 divide-y divide-border border-t border-border">
      {data.map((t) => (
        <li key={t.id}>
          <Link
            to={`/inbox/${t.id}`}
            className="flex items-start justify-between gap-3 py-2 hover:bg-muted/30 -mx-1 px-1 rounded-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-foreground">
                {t.subject || <span className="italic text-muted-foreground">no subject</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                {t.customer_name || t.customer_email || 'unknown'} · {t.channel}
              </div>
            </div>
            <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {timeAgo(t.last_message_at)}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Patterns() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { data = [], isLoading } = useQuery({
    queryKey: ['pattern_signals'],
    queryFn: async () => {
      const res: any = await bb
        .from('pattern_signals')
        .select('*')
        .order('count', { ascending: false })
        .limit(50);
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as PatternSignal[];
    },
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Cross-cuts</p>
          <h1 className="page-title">
            Patterns <em>in motion</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Cross-cutting issues the agent has noticed — each one a policy or product fix waiting to happen.
          </p>
        </div>
      </div>

      <div className="px-8 py-7">
        {isLoading ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-butter animate-pulse-soft" />
            <span className="eyebrow !text-[10px]">loading patterns…</span>
          </div>
        ) : data.length === 0 ? (
          <div className="max-w-md py-8">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-md border border-border bg-card">
              <Sparkles className="h-5 w-5 text-butter" strokeWidth={1.75} />
            </div>
            <p className="font-display text-[26px] leading-tight tracking-tight">
              Nothing's <em className="font-editorial italic text-butter">repeating</em> yet.
            </p>
            <p className="mt-2 font-editorial italic text-[14px] text-muted-foreground">
              As tickets accumulate, the agent will surface what's coming up over and over.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((p) => {
              const ids = p.sample_ticket_ids ?? [];
              const hasTickets = ids.length > 0;
              const isOpen = !!expanded[p.id];
              return (
                <div key={p.id} className="card-flat p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="eyebrow !text-[10px] mb-1.5">{p.signal_kind}</p>
                      <h3 className="font-display text-[19px] leading-tight tracking-tight text-foreground truncate">
                        {p.signal_key}
                      </h3>
                    </div>
                    <span className="font-mono num text-[18px] text-butter shrink-0">{p.count}×</span>
                  </div>
                  <div className="mt-3 font-mono text-[11px] text-muted-foreground">
                    first {timeAgo(p.first_seen_at)} · last {timeAgo(p.last_seen_at)}
                  </div>
                  {hasTickets && (
                    <button
                      type="button"
                      onClick={() => setExpanded((s) => ({ ...s, [p.id]: !s[p.id] }))}
                      className="mt-2 -ml-1 flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                      <span>
                        {ids.length} sample ticket{ids.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  )}
                  {isOpen && hasTickets && <PatternTickets ids={ids} />}
                  {p.surfaced && <div className="mt-3"><Badge variant="amber">surfaced</Badge></div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
