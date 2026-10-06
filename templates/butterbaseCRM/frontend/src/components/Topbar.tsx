import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { LogOut, Sparkles } from 'lucide-react';
import { bb } from '@/lib/butterbase';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { useWorkspaceStore } from '@/lib/workspace';
import { AISearchDialog } from './AISearchDialog';
import { AgentLauncher } from './agent/AgentLauncher';
import { FLAGS, isFlagEnabled } from '@/lib/featureFlags';

interface AuthUser {
  id: string;
  email: string;
  display_name?: string;
}

export function Topbar() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    bb.auth.getUser().then(({ data }) => setUser((data as AuthUser | null) ?? null));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function signOut() {
    await bb.auth.signOut();
    useWorkspaceStore.getState().setWorkspace(null);
    qc.clear();
    navigate('/login', { replace: true });
  }

  const label = user?.display_name || user?.email || '?';
  const initials = (user?.display_name ?? user?.email ?? 'U').slice(0, 2).toUpperCase();

  return (
    <header className="relative flex h-16 items-center gap-4 px-5">
      <WorkspaceSwitcher />

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="hidden lg:flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card/50 text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-[13px]"
      >
        <Sparkles className="h-3.5 w-3.5 text-butter" strokeWidth={1.75} />
        <span>AI search</span>
        <span className="ml-3 font-mono text-[10px] px-1.5 py-0.5 rounded bg-background border border-border num">⌘K</span>
      </button>
      <AISearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      {isFlagEnabled(FLAGS.aiAssistant) && <AgentLauncher />}

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
            <Avatar className="h-8 w-8 ring-1 ring-border">
              <AvatarFallback className="text-[11px] font-semibold bg-butter/15 text-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="flex flex-col py-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {user?.email && user.display_name ? (
              <span className="text-xs text-muted-foreground mt-1.5 truncate">{user.email}</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={signOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="absolute inset-x-0 bottom-0 rule-dotted" />
    </header>
  );
}
