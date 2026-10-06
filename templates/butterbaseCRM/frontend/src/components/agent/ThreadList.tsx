import { useAgentThreads } from '@/hooks/useAgentThreads';
import { useAgentUIStore } from '@/lib/agent';
import { useWorkspaceStore } from '@/lib/workspace';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { History } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useState } from 'react';

export function ThreadList() {
  const wsId = useWorkspaceStore((s) => s.workspaceId);
  const { data: threads } = useAgentThreads(wsId);
  const setThread = useAgentUIStore((s) => s.setThread);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Recent threads">
          <History className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-1" align="end">
        <ul className="max-h-72 overflow-auto divide-y divide-border">
          {(threads ?? []).map((t) => (
            <li key={t.id}>
              <button
                onClick={() => { setThread(t.id); setOpen(false); }}
                className="block w-full text-left px-2 py-1.5 hover:bg-foreground/[0.04] rounded"
              >
                <p className="text-[12.5px] truncate">{t.title ?? 'Untitled'}</p>
                <p className="text-[10.5px] text-muted-foreground font-mono">
                  {formatDistanceToNow(new Date(t.last_message_at), { addSuffix: true })} · {t.mode}
                </p>
              </button>
            </li>
          ))}
          {(threads ?? []).length === 0 && (
            <p className="p-3 text-[12px] text-muted-foreground font-editorial italic">No threads yet.</p>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
