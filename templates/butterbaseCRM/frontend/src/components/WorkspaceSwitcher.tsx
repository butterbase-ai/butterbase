import { useQueryClient } from '@tanstack/react-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMemberships } from '@/hooks/useMemberships';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useWorkspaceStore } from '@/lib/workspace';

export function WorkspaceSwitcher() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const { data: memberships } = useMemberships();
  const { data: workspaces } = useWorkspaces();

  const current = workspaces?.find((w) => w.id === workspaceId);
  const accessibleIds = new Set((memberships ?? []).map((m) => m.workspace_id));
  const list = (workspaces ?? []).filter((w) => accessibleIds.has(w.id));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="group h-9 gap-2 px-2 hover:bg-foreground/[0.04]"
        >
          <span className="grid place-items-center h-6 w-6 rounded-md bg-butter/20 ring-1 ring-butter/40 font-display text-[12px] font-semibold text-foreground">
            {(current?.name ?? 'B').slice(0, 1).toUpperCase()}
          </span>
          <span className="max-w-[12rem] truncate font-display text-[15px] tracking-tight text-foreground">
            {current?.name ?? 'Select workspace'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50 group-hover:opacity-80 transition-opacity" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {list.map((ws) => (
          <DropdownMenuItem
            key={ws.id}
            onClick={() => {
              if (ws.id !== workspaceId) {
                setWorkspace(ws.id);
                qc.invalidateQueries();
              }
            }}
          >
            <Check
              className={`mr-2 h-4 w-4 ${ws.id === workspaceId ? 'opacity-100' : 'opacity-0'}`}
            />
            <span className="truncate">{ws.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/onboard')}>
          <Plus className="mr-2 h-4 w-4" />
          Create workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
