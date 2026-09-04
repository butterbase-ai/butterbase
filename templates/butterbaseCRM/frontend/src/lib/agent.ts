import { create } from 'zustand';
import { bb } from './butterbase';
import type { AgentSseEvent } from './types';

const API_URL = import.meta.env.VITE_BUTTERBASE_API_URL as string;
const APP_ID = import.meta.env.VITE_BUTTERBASE_APP_ID as string;

export interface AgentChatRequest {
  thread_id?: string | null;
  workspace_id?: string;
  mode?: 'onboarding' | 'copilot';
  user_message: string;
  client_context?: { route?: string; entity?: { type: string; id: string } | null };
}

function getAccessToken(): string | null {
  const sm = (bb as any).sessionManager;
  const session = sm?.getSession?.();
  return session?.accessToken ?? null;
}

async function refreshAccessToken(): Promise<string | null> {
  const sm = (bb as any).sessionManager;
  if (typeof sm?.refreshSession !== 'function') return null;
  try {
    const session = await sm.refreshSession();
    return session?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function openAgentStream(body: AgentChatRequest, signal?: AbortSignal): Promise<ReadableStream<AgentSseEvent>> {
  let jwt = getAccessToken();
  if (!jwt) {
    jwt = await refreshAccessToken();
    if (!jwt) throw new Error('not_authenticated');
  }

  let res = await fetch(`${API_URL}/v1/${APP_ID}/fn/agent-chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  // Auto-refresh on stale JWT.
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      res = await fetch(`${API_URL}/v1/${APP_ID}/fn/agent-chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fresh}`, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
    }
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`agent_chat_${res.status}: ${detail.slice(0, 200)}`);
  }

  return res.body.pipeThrough(new TextDecoderStream()).pipeThrough(parseSseStream());
}

function parseSseStream(): TransformStream<string, AgentSseEvent> {
  let buf = '';
  return new TransformStream({
    transform(chunk, controller) {
      buf += chunk;
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        let eventName = 'message';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          controller.enqueue({ event: eventName as any, data } as AgentSseEvent);
        } catch { /* skip malformed */ }
      }
    },
  });
}

// ── Proposal tool_name → REST endpoint map ───────────────────────────────

export interface ProposalEndpoint {
  method: 'POST' | 'PATCH' | 'INVOKE_FN';
  path: string; // table name for REST; function name for INVOKE_FN; or 'deals?id=eq.{deal_id}' style for PATCH (substitute {field})
  buildBody: (p: any, workspaceId: string, userId: string) => any;
}

export const PROPOSAL_ENDPOINTS: Record<string, ProposalEndpoint> = {
  propose_create_company: {
    method: 'POST',
    path: 'companies',
    buildBody: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_create_person: {
    method: 'POST',
    path: 'people',
    buildBody: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_create_deal: {
    method: 'POST',
    path: 'deals',
    buildBody: (p, ws, uid) => ({ stage: 'lead', currency: 'USD', ...p, workspace_id: ws, created_by: uid, owner_user_id: uid }),
  },
  propose_update_deal_stage: {
    method: 'PATCH',
    path: 'deals', // caller .eq('id', payload.deal_id)
    buildBody: (p) => ({ stage: p.stage }),
  },
  propose_add_note: {
    method: 'POST',
    path: 'notes',
    buildBody: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_invite_member: {
    method: 'INVOKE_FN',
    path: 'invite-member',
    buildBody: (p, ws) => ({ email: p.email, role: p.role ?? 'member', workspace_id: ws }),
  },
};

// ── Drawer UI Zustand store ──────────────────────────────────────────────

export interface AgentViewContext {
  object_type: 'people' | 'companies' | 'deals' | 'meetings';
  view_name: string;
  view_id: string | null;
  filters: Array<{ field: string; op: string; value?: unknown }>;
}

interface AgentUIState {
  open: boolean;
  threadId: string | null;
  sessionKey: number; // bumps on user-initiated thread switch; AgentChat is keyed by it.
  viewContext: AgentViewContext | null;
  openDrawer: (opts?: { threadId?: string | null; viewContext?: AgentViewContext | null }) => void;
  closeDrawer: () => void;
  /** User-initiated: switches thread AND remounts AgentChat (fresh stream state). */
  setThread: (id: string | null) => void;
  /** Server-initiated: a brand-new thread was just created mid-stream; bubble id up WITHOUT remounting. */
  promoteThreadId: (id: string) => void;
  setViewContext: (ctx: AgentViewContext | null) => void;
}

export const useAgentUIStore = create<AgentUIState>((set, get) => ({
  open: false,
  threadId: null,
  sessionKey: 0,
  viewContext: null,
  openDrawer: (opts) => set({
    open: true,
    threadId: opts?.threadId ?? null,
    sessionKey: get().sessionKey + 1,
    ...(opts?.viewContext !== undefined ? { viewContext: opts.viewContext } : {}),
  }),
  closeDrawer: () => set({ open: false }),
  setThread: (id) => set({ threadId: id, sessionKey: get().sessionKey + 1 }),
  promoteThreadId: (id) => set({ threadId: id }),
  setViewContext: (ctx) => set({ viewContext: ctx }),
}));
