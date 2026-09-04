import { useEffect } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useAgentProposals } from '@/hooks/useAgentProposals';
import { useAgentUIStore } from '@/lib/agent';
import { useWorkspaceStore } from '@/lib/workspace';

export function AgentLauncher() {
  const wsId = useWorkspaceStore((s) => s.workspaceId);
  const open = useAgentUIStore((s) => s.openDrawer);
  const { data: proposals } = useAgentProposals(wsId);
  const pendingCount = (proposals ?? []).filter((p) => p.status === 'pending').length;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <button
      type="button"
      onClick={() => open()}
      aria-label="Open AI assistant"
      title="Open AI assistant (⌘J)"
      className="relative hidden lg:flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card/50 text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-[13px]"
    >
      <MessageCircleQuestion className="h-3.5 w-3.5 text-butter" strokeWidth={1.75} />
      <span>Assistant</span>
      <span className="ml-3 font-mono text-[10px] px-1.5 py-0.5 rounded bg-background border border-border num">⌘J</span>
      {pendingCount > 0 && (
        <span className="absolute -top-1 -right-1 h-4 min-w-[16px] rounded-full bg-coral text-background text-[10px] font-mono leading-4 px-1 text-center">
          {pendingCount}
        </span>
      )}
    </button>
  );
}
