import { useEffect, useState, useMemo, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAgentStream } from '@/hooks/useAgentStream';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useAgentRealtime } from '@/hooks/useAgentRealtime';
import { useAgentProposals } from '@/hooks/useAgentProposals';
import { useAgentUIStore } from '@/lib/agent';
import type { AgentProposal } from '@/lib/types';
import { MessageList } from './MessageList';
import { AskUserCard } from './AskUserCard';
import { SuggestNextStepCard } from './SuggestNextStepCard';
import { SuggestLinkAccountCard } from './SuggestLinkAccountCard';
import { ConfirmActionCard } from './ConfirmActionCard';
import { SocialPostDraftCard } from './SocialPostDraftCard';

interface Props {
  threadId: string | null;
  workspaceId: string;
  mode: 'onboarding' | 'copilot';
  onThreadIdChange?: (id: string) => void;
  onUiEvent?: (kind: string, payload: any) => void;
  fullscreen?: boolean;
}

export function AgentChat({ threadId, workspaceId, mode, onThreadIdChange, onUiEvent, fullscreen }: Props) {
  const [draft, setDraft] = useState('');
  const { state, send, clearUiEvent } = useAgentStream();
  const location = useLocation();
  const viewContext = useAgentUIStore((s) => s.viewContext);
  const { data: messages } = useAgentMessages(threadId);
  const { data: allProposals } = useAgentProposals(workspaceId);
  const threadProposals: AgentProposal[] = (allProposals ?? []).filter((p) => p.thread_id === threadId);

  useAgentRealtime(threadId, workspaceId);

  // Promote new thread id from stream to parent.
  useEffect(() => {
    if (state.threadId && state.threadId !== threadId) onThreadIdChange?.(state.threadId);
  }, [state.threadId, threadId, onThreadIdChange]);

  // Surface ui events to parent (for onboarding navigation, etc.)
  useEffect(() => {
    if (state.pendingUiEvent) onUiEvent?.(state.pendingUiEvent.kind, state.pendingUiEvent.payload);
  }, [state.pendingUiEvent, onUiEvent]);

  const streamingToolCalls = useMemo(
    () => Object.entries(state.toolCalls).map(([id, tc]) => ({ id, ...(tc as any) })),
    [state.toolCalls],
  );
  const streamingAssistantText = state.status === 'streaming' && state.textBuffer ? state.textBuffer : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const msg = draft.trim();
    if (!msg || state.status === 'streaming') return;
    setDraft('');
    await send({
      thread_id: state.threadId ?? threadId,
      workspace_id: workspaceId,
      mode,
      user_message: msg,
      client_context: { route: location.pathname, entity: null, view: viewContext ?? undefined } as any,
    });
  }

  function sendSynthetic(text: string) {
    void send({
      thread_id: state.threadId ?? threadId,
      workspace_id: workspaceId,
      mode,
      user_message: text,
      client_context: { route: location.pathname, entity: null, view: viewContext ?? undefined } as any,
    });
  }

  const pad = fullscreen ? 'max-w-3xl mx-auto w-full' : '';

  return (
    <div className={`flex h-full min-h-0 flex-col ${pad}`}>
      <MessageList
        messages={messages ?? []}
        proposals={threadProposals}
        streamingAssistantText={streamingAssistantText}
        streamingToolCalls={streamingToolCalls}
        optimisticUserText={
          state.pendingUserMessage &&
          !(messages ?? []).some((m) => m.id === state.confirmedUserMessageId)
            ? state.pendingUserMessage
            : null
        }
        onProposalResolved={(p, status) => {
          if (status !== 'approved') return;
          sendSynthetic(`[system: proposal ${p.id} (${p.tool_name}) approved]`);
        }}
      />

      {state.pendingUiEvent?.kind === 'ask_user' && (
        <div className="px-3 pb-2">
          <AskUserCard
            question={state.pendingUiEvent.payload.question}
            options={state.pendingUiEvent.payload.options}
            allow_free_text={state.pendingUiEvent.payload.allow_free_text}
            onSubmit={(reply) => { clearUiEvent(); sendSynthetic(reply); }}
          />
        </div>
      )}

      {state.pendingUiEvent?.kind === 'suggest_link_account' && (
        <div className="px-3 pb-2">
          <SuggestLinkAccountCard
            provider={state.pendingUiEvent.payload.provider}
            reason={state.pendingUiEvent.payload.reason}
            onLinked={() => {
              const provider = state.pendingUiEvent!.payload.provider;
              clearUiEvent();
              sendSynthetic(`[system: connected ${provider}]`);
            }}
          />
        </div>
      )}

      {state.pendingUiEvent?.kind === 'confirm_action' && (
        <div className="px-3 pb-2">
          <ConfirmActionCard
            label={state.pendingUiEvent.payload.label}
            endpoint={state.pendingUiEvent.payload.endpoint}
            body={state.pendingUiEvent.payload.body}
            cost_estimate={state.pendingUiEvent.payload.cost_estimate}
            onResolved={(ok) => {
              const toolName = state.pendingUiEvent!.payload.tool_name;
              clearUiEvent();
              sendSynthetic(ok ? `[system: action ${toolName} ran ok]` : `[system: action ${toolName} failed]`);
            }}
          />
        </div>
      )}

      {state.pendingUiEvent?.kind === 'suggest_next_step' && (
        <div className="px-3 pb-2">
          <SuggestNextStepCard
            label={state.pendingUiEvent.payload.label}
            action={state.pendingUiEvent.payload.action}
          />
        </div>
      )}

      {state.pendingUiEvent?.kind === 'draft_social_post' && (
        <div className="px-3 pb-2">
          <SocialPostDraftCard
            payload={state.pendingUiEvent.payload}
            onDismiss={clearUiEvent}
          />
        </div>
      )}

      {state.error && (
        <div className="px-3 pb-2">
          <p className="text-[12px] text-coral font-mono">{state.error.code}: {state.error.message}</p>
        </div>
      )}

      <form onSubmit={onSubmit} className="border-t border-border p-2 flex gap-2">
        <Textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e as any); } }}
          placeholder="Ask anything…"
          className="flex-1 resize-none text-[13.5px]"
          disabled={state.status === 'streaming'}
        />
        <Button type="submit" disabled={state.status === 'streaming' || !draft.trim()} size="icon" className="h-9 w-9 self-end">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}
