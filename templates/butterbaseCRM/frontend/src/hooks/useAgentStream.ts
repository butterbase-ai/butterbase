import { useCallback, useReducer, useRef } from 'react';
import { openAgentStream, type AgentChatRequest } from '@/lib/agent';
import type { AgentSseEvent } from '@/lib/types';

interface ToolCallState { name: string; args: any; status: 'running' | 'done' | 'error'; summary?: string; error?: string }

export interface StreamState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  threadId: string | null;
  currentAssistantId: string | null;
  textBuffer: string;
  /** Optimistic user message shown immediately on send, cleared when the persisted row arrives via realtime. */
  pendingUserMessage: string | null;
  /** Server-confirmed id of the just-sent user message; let the consumer hide the optimistic bubble once present. */
  confirmedUserMessageId: string | null;
  toolCalls: Record<string, ToolCallState>;
  newProposalIds: string[];
  pendingUiEvent: { kind: string; payload: any } | null;
  error: { code: string; message: string } | null;
}

const initial: StreamState = {
  status: 'idle', threadId: null, currentAssistantId: null, textBuffer: '',
  pendingUserMessage: null, confirmedUserMessageId: null,
  toolCalls: {}, newProposalIds: [], pendingUiEvent: null, error: null,
};

type Action =
  | { type: 'reset'; threadId: string | null; userMessage: string }
  | { type: 'event'; ev: AgentSseEvent }
  | { type: 'error'; err: Error }
  | { type: 'clearUiEvent' };

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'reset':
      return { ...initial, threadId: action.threadId, status: 'streaming', pendingUserMessage: action.userMessage };
    case 'error':
      return { ...state, status: 'error', error: { code: 'client', message: action.err.message } };
    case 'clearUiEvent':
      return { ...state, pendingUiEvent: null };
    case 'event': {
      const { event, data } = action.ev;
      switch (event) {
        case 'thread':            return { ...state, threadId: (data as any).thread_id };
        case 'user_message_id':   return { ...state, confirmedUserMessageId: (data as any).id };
        case 'assistant_start':   return { ...state, currentAssistantId: (data as any).message_id, textBuffer: '' };
        case 'assistant_delta':   return { ...state, textBuffer: state.textBuffer + (data as any).text };
        case 'tool_call_start': {
          const d = data as any;
          return { ...state, toolCalls: { ...state.toolCalls, [d.tool_call_id]: { name: d.name, args: d.args, status: 'running' } } };
        }
        case 'tool_call_done': {
          const d = data as any;
          const prev = state.toolCalls[d.tool_call_id] ?? { name: '?', args: {}, status: 'running' as const };
          return { ...state, toolCalls: { ...state.toolCalls, [d.tool_call_id]: { ...prev, status: d.ok ? 'done' : 'error', summary: d.summary, error: d.error } } };
        }
        case 'proposal_created': return { ...state, newProposalIds: [...state.newProposalIds, (data as any).proposal_id] };
        case 'ui_event':         return { ...state, pendingUiEvent: { kind: (data as any).kind, payload: (data as any).payload } };
        case 'assistant_end':    return { ...state, currentAssistantId: null, textBuffer: '' };
        case 'error':            return { ...state, status: 'error', error: data as any };
        case 'done':             return { ...state, status: 'done' };
        default:                 return state;
      }
    }
  }
}

export function useAgentStream() {
  const [state, dispatch] = useReducer(reducer, initial);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (body: AgentChatRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: 'reset', threadId: body.thread_id ?? null, userMessage: body.user_message });
    try {
      const stream = await openAgentStream(body, ac.signal);
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        dispatch({ type: 'event', ev: value });
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') dispatch({ type: 'error', err });
    }
  }, []);

  const abort = useCallback(() => abortRef.current?.abort(), []);
  const clearUiEvent = useCallback(() => dispatch({ type: 'clearUiEvent' }), []);

  return { state, send, abort, clearUiEvent };
}
