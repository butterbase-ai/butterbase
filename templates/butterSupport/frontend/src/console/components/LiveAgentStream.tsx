import { useState } from 'react';
import { ChevronRight, Wrench, CheckCircle2, Bot, Stethoscope, PencilLine, MessagesSquare, AlertOctagon, AlertTriangle, Radio } from 'lucide-react';
import type { DoServerEvent } from '@/console/lib/do-ws';
import { cn } from '@/console/lib/utils';

type Tone = 'muted' | 'positive' | 'butter' | 'crust' | 'red';

export function LiveAgentStream({ events }: { events: DoServerEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="p-5">
        <div className="section-label mb-2">Idle</div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          No live agent activity yet. Run <span className="text-caramel">Diagnose</span> or <span className="text-caramel">Draft</span> to kick off the agent.
        </p>
      </div>
    );
  }
  return (
    <div className="relative px-5 py-4 space-y-2">
      <div className="absolute left-[31px] top-4 bottom-4 w-px bg-gradient-to-b from-caramel/40 via-[rgb(244_236_221/0.08)] to-transparent" />
      {events.map((e, i) => (
        <EventRow key={i} ev={e} />
      ))}
    </div>
  );
}

function EventRow({ ev }: { ev: DoServerEvent }) {
  const [open, setOpen] = useState(false);
  if (ev.type === 'tool_call_start') {
    return (
      <Row tone="muted" icon={Wrench} onClick={() => setOpen(!open)} expandable>
        <span>Calling <code className="font-mono text-caramel/90">{ev.tool}</code></span>
        {open && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-rule-soft bg-paper-warm p-2.5 font-mono text-[11px] text-foreground/80">
            {JSON.stringify(ev.args, null, 2)}
          </pre>
        )}
      </Row>
    );
  }
  if (ev.type === 'tool_call_result') {
    const r = ev.result;
    let summary = '';
    if (r && typeof r === 'object') {
      if (Array.isArray(r)) summary = `${r.length} items`;
      else if ('chunks' in r) summary = `${(r as any).chunks?.length ?? '?'} chunks`;
      else summary = 'returned';
    }
    return (
      <Row tone="positive" icon={CheckCircle2} onClick={() => setOpen(!open)} expandable>
        <span><code className="font-mono text-positive/90">{ev.tool}</code> — {summary}</span>
        {open && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-rule-soft bg-paper-warm p-2.5 font-mono text-[11px] text-foreground/80">
            {JSON.stringify(r, null, 2)}
          </pre>
        )}
      </Row>
    );
  }
  if (ev.type === 'agent_message') {
    const preview = (ev.content || '').slice(0, 120);
    return (
      <Row tone="positive" icon={Bot} onClick={() => setOpen(!open)} expandable>
        <span>{open ? '' : preview + ((ev.content || '').length > 120 ? '…' : '')}</span>
        {open && <div className="mt-1.5 whitespace-pre-wrap text-sm text-foreground/90">{ev.content}</div>}
      </Row>
    );
  }
  if (ev.type === 'state') {
    return <Row tone="muted" icon={Radio}><span className="font-mono uppercase text-[10px] tracking-[0.18em]">state → {ev.agent_state}</span></Row>;
  }
  if (ev.type === 'hello') {
    return <Row tone="muted" icon={Radio}><span className="font-mono uppercase text-[10px] tracking-[0.18em]">session started · state={ev.agent_state}</span></Row>;
  }
  if (ev.type === 'diagnosis') {
    return <Row tone="positive" icon={Stethoscope}><span>Diagnosis posted</span></Row>;
  }
  if (ev.type === 'draft_proposed') {
    return <Row tone="butter" icon={PencilLine}><span>Draft proposed{ev.confidence ? ` (${ev.confidence})` : ''}</span></Row>;
  }
  if (ev.type === 'followup_question_proposed') {
    return <Row tone="butter" icon={MessagesSquare}><span>Follow-up question proposed</span></Row>;
  }
  if (ev.type === 'escalation') {
    return <Row tone="crust" icon={AlertOctagon}><span>Escalation: {ev.reason}</span></Row>;
  }
  if (ev.type === 'error') {
    return <Row tone="red" icon={AlertTriangle}><span>{ev.reason}{ev.message ? `: ${ev.message}` : ''}</span></Row>;
  }
  if (ev.type === 'heartbeat_ack') return null;
  return <Row tone="muted" icon={Radio}><span className="font-mono text-[11px]">{JSON.stringify(ev)}</span></Row>;
}

function Row({
  children,
  tone,
  icon: Icon,
  onClick,
  expandable,
}: {
  children: React.ReactNode;
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  expandable?: boolean;
}) {
  const toneClass: Record<Tone, { dot: string; ring: string; text: string }> = {
    muted: { dot: 'bg-paper-warm text-muted-foreground', ring: 'border-rule-soft', text: 'text-muted-foreground' },
    positive: { dot: 'bg-positive/10 text-positive', ring: 'border-positive/25', text: 'text-foreground/90' },
    butter: { dot: 'bg-butter-200 text-caramel', ring: 'border-butter-300/60', text: 'text-foreground/90' },
    crust: { dot: 'bg-butter-200 text-caramel', ring: 'border-caramel/25', text: 'text-foreground/90' },
    red: { dot: 'bg-destructive/15 text-destructive', ring: 'border-destructive/30', text: 'text-destructive' },
  };
  const t = toneClass[tone];
  return (
    <div className="relative flex items-start gap-3">
      <div className={cn('relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full', t.dot)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div
        onClick={onClick}
        className={cn(
          'flex-1 rounded-xl border bg-paper-soft px-3.5 py-2 text-xs leading-relaxed',
          t.ring,
          t.text,
          onClick && 'cursor-pointer hover:bg-paper-soft transition-colors',
        )}
      >
        <div className="flex items-start gap-2">
          {expandable && <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/60" />}
          <div className="flex-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
