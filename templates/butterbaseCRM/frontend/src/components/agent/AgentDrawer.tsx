import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentUIStore } from '@/lib/agent';
import { useWorkspaceStore } from '@/lib/workspace';
import { AgentChat } from './AgentChat';
import { ThreadList } from './ThreadList';

export function AgentDrawer() {
  const open = useAgentUIStore((s) => s.open);
  const close = useAgentUIStore((s) => s.closeDrawer);
  const threadId = useAgentUIStore((s) => s.threadId);
  const sessionKey = useAgentUIStore((s) => s.sessionKey);
  const setThread = useAgentUIStore((s) => s.setThread);
  const promoteThreadId = useAgentUIStore((s) => s.promoteThreadId);
  const wsId = useWorkspaceStore((s) => s.workspaceId);
  const viewContext = useAgentUIStore((s) => s.viewContext);
  const setViewContext = useAgentUIStore((s) => s.setViewContext);

  if (!open) return null;

  return (
    <aside
      className="fixed right-0 top-0 z-40 h-screen w-[440px] border-l border-border bg-background shadow-2xl flex flex-col"
      role="complementary"
      aria-label="AI assistant"
    >
      <header className="h-12 flex items-center justify-between border-b border-border px-3 gap-1">
        <span className="font-display tracking-tight text-[14px]">Ask AI</span>
        {viewContext && (
          <span className="ml-1 inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-0.5 text-[11.5px]">
            <span className="font-medium text-foreground">{viewContext.view_name}</span>
            <button onClick={() => setViewContext(null)} className="text-muted-foreground hover:text-coral" title="Remove context">
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <span className="flex-1" />
        <ThreadList />
        <Button variant="ghost" size="sm" className="h-7 px-2 gap-1" onClick={() => setThread(null)} title="New conversation">
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        {wsId ? (
          <AgentChat
            key={sessionKey}
            threadId={threadId}
            workspaceId={wsId}
            mode="copilot"
            onThreadIdChange={(id) => promoteThreadId(id)}
          />
        ) : (
          <p className="p-4 font-editorial italic text-[13px] text-muted-foreground">Select a workspace to chat.</p>
        )}
      </div>
    </aside>
  );
}
