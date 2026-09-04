import ReactMarkdown from 'react-markdown';
import { MoreVertical, User, Bot, PencilLine, Wrench, Headset } from 'lucide-react';
import { useState } from 'react';
import type { SupportMessage } from '@/console/lib/types';
import { cn, timeAgo } from '@/console/lib/utils';
import { api } from '@/console/lib/api';
import { toast } from '@/console/components/ui/toast';

interface RoleStyle {
  align: string;
  bubble: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  badgeClass: string;
}

function roleStyle(role: SupportMessage['role']): RoleStyle {
  switch (role) {
    case 'customer':
      return {
        align: 'self-start',
        bubble: 'bg-paper-soft border border-rule-soft',
        label: 'Customer',
        icon: User,
        iconClass: 'bg-paper-warm text-foreground/80',
        badgeClass: 'text-muted-foreground',
      };
    case 'agent_draft':
      return {
        align: 'self-start',
        bubble: 'bg-butter-50 border border-butter-300/60',
        label: 'Awaiting approval',
        icon: PencilLine,
        iconClass: 'bg-butter-200 text-caramel',
        badgeClass: 'text-caramel',
      };
    case 'founder':
      return {
        align: 'self-end',
        bubble: 'bg-butter-100 border border-caramel/30',
        label: 'You',
        icon: Headset,
        iconClass: 'bg-butter-200 text-caramel',
        badgeClass: 'text-caramel',
      };
    case 'assistant':
      return {
        align: 'self-start',
        bubble: 'bg-positive/[0.06] border border-positive/30',
        label: 'Assistant',
        icon: Bot,
        iconClass: 'bg-positive/15 text-positive',
        badgeClass: 'text-positive',
      };
    case 'system':
      return {
        align: 'self-center',
        bubble: 'bg-transparent',
        label: 'System',
        icon: Wrench,
        iconClass: 'text-muted-foreground/50',
        badgeClass: 'text-muted-foreground/70',
      };
    default:
      return {
        align: 'self-start',
        bubble: 'bg-paper-soft border border-rule-soft',
        label: String(role),
        icon: User,
        iconClass: 'bg-paper-warm text-foreground/80',
        badgeClass: 'text-muted-foreground',
      };
  }
}

export function ConversationThread({ messages, ticketId }: { messages: SupportMessage[]; ticketId: string }) {
  return (
    <div className="flex flex-col gap-5 px-6 py-6">
      {messages.map((m) => (
        <MessageBubble key={m.id} m={m} ticketId={ticketId} />
      ))}
      {messages.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-12">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em]">No messages yet.</span>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ m, ticketId }: { m: SupportMessage; ticketId: string }) {
  const [menu, setMenu] = useState(false);
  const style = roleStyle(m.role);
  const isCenter = m.role === 'system';

  async function markCommitment() {
    setMenu(false);
    try {
      const res: any = await api.markAsCommitment({ ticket_id: ticketId, message_id: m.id });
      if (res?.duplicate) {
        toast.info('Already marked as commitment.');
      } else if (res?.title) {
        toast.success(res.title, { title: 'Marked as commitment' });
      } else {
        toast.success('Marked as commitment.');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Failed to mark as commitment');
    }
  }

  if (isCenter) {
    return (
      <div className="flex items-center gap-3 self-center max-w-md w-full">
        <span className="h-px flex-1 bg-paper-warm" />
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 italic">
          {m.body}
        </div>
        <span className="h-px flex-1 bg-paper-warm" />
      </div>
    );
  }

  const Icon = style.icon;
  return (
    <div className={cn('flex max-w-[82%] gap-3 animate-rise', style.align)}>
      {m.role !== 'founder' && (
        <div className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full', style.iconClass)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
      )}
      <div className={cn('flex-1 rounded-2xl px-4 py-3', style.bubble)}>
        <div className="flex items-center justify-between gap-3">
          <span className={cn('font-mono text-[10px] uppercase tracking-[0.16em] font-medium', style.badgeClass)}>
            {style.label}
          </span>
          <div className="relative">
            <button
              onClick={() => setMenu((s) => !s)}
              className="rounded-full p-1 text-muted-foreground/60 hover:bg-paper-warm hover:text-foreground transition-colors"
            >
              <MoreVertical className="h-3 w-3" />
            </button>
            {menu && (
              <div className="absolute right-0 z-10 mt-1 w-48 rounded-xl border border-rule bg-paper-soft py-1 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]">
                <button
                  className="block w-full px-3.5 py-2 text-left text-xs text-foreground/90 hover:bg-butter-100"
                  onClick={markCommitment}
                >
                  Mark as commitment
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="prose-msg mt-1.5 text-sm">
          <ReactMarkdown>{m.body || ''}</ReactMarkdown>
        </div>
        <div className="mt-2 font-mono text-[10px] text-muted-foreground/60 tabular-nums">{timeAgo(m.created_at)}</div>
      </div>
      {m.role === 'founder' && (
        <div className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full', style.iconClass)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
      )}
    </div>
  );
}
