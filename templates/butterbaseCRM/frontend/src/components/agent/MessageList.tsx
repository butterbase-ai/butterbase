import { useEffect, useMemo, useRef } from 'react';
import type { AgentMessage, AgentProposal } from '@/lib/types';
import { AssistantBubble } from './AssistantBubble';
import { UserBubble } from './UserBubble';
import { ToolCallChip } from './ToolCallChip';
import { ProposalCard } from './ProposalCard';

interface StreamingToolCall { id: string; name: string; status: 'running' | 'done' | 'error'; summary?: string; error?: string }

interface Props {
  messages: AgentMessage[];
  proposals: AgentProposal[];
  streamingAssistantText: string | null;
  streamingToolCalls: StreamingToolCall[];
  optimisticUserText: string | null;
  onProposalResolved?: (p: AgentProposal, status: 'approved' | 'rejected') => void;
}

export function MessageList({ messages, proposals, streamingAssistantText, streamingToolCalls, optimisticUserText, onProposalResolved }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(() => {
    type Item = { kind: 'm'; at: string; m: AgentMessage } | { kind: 'p'; at: string; p: AgentProposal };
    const ms: Item[] = messages.map((m) => ({ kind: 'm', at: m.created_at, m }));
    const ps: Item[] = proposals.map((p) => ({ kind: 'p', at: p.created_at, p }));
    return [...ms, ...ps].sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, proposals]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, streamingAssistantText, streamingToolCalls.length, optimisticUserText]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-4 space-y-3">
      {items.length === 0 && !streamingAssistantText && (
        <p className="font-editorial italic text-[13px] text-muted-foreground text-center mt-6">
          Ask anything about your workspace — companies, deals, pipeline. I can also propose changes.
        </p>
      )}

      {items.map((it) => {
        if (it.kind === 'p') {
          return (
            <ProposalCard
              key={it.p.id}
              proposal={it.p}
              onResolved={(status) => onProposalResolved?.(it.p, status)}
            />
          );
        }
        const m = it.m;
        if (m.role === 'user' && m.content) return <UserBubble key={m.id} text={m.content} />;
        if (m.role === 'assistant' && m.content) return <AssistantBubble key={m.id} text={m.content} />;
        if (m.role === 'tool' && m.tool_results) {
          const tr = m.tool_results;
          const status: 'done' | 'error' = tr.outcome?.ok ? 'done' : 'error';
          return (
            <div key={m.id}>
              <ToolCallChip
                name={tr.name ?? '?'}
                status={status}
                summary={tr.outcome?.ok ? tr.outcome.summary : undefined}
                error={!tr.outcome?.ok ? tr.outcome?.error : undefined}
              />
            </div>
          );
        }
        return null;
      })}

      {optimisticUserText !== null && <UserBubble text={optimisticUserText} />}

      {streamingToolCalls.map((tc) => (
        <div key={tc.id}><ToolCallChip name={tc.name} status={tc.status} summary={tc.summary} error={tc.error} /></div>
      ))}

      {streamingAssistantText !== null && <AssistantBubble text={streamingAssistantText} streaming />}
    </div>
  );
}
