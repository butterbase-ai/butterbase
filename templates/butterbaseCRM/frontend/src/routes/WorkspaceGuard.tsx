import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useMemberships } from '@/hooks/useMemberships';
import { useWorkspaceStore } from '@/lib/workspace';

export function WorkspaceGuard() {
  const { data: memberships, isLoading } = useMemberships();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);

  useEffect(() => {
    if (!memberships || memberships.length === 0) return;
    // Auto-select first workspace if none selected, or if current selection is invalid.
    const valid = workspaceId && memberships.some((m) => m.workspace_id === workspaceId);
    if (!valid) setWorkspace(memberships[0].workspace_id);
  }, [memberships, workspaceId, setWorkspace]);

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }
  if (!memberships || memberships.length === 0) {
    return <Navigate to="/onboard" replace />;
  }
  if (!workspaceId) {
    // useEffect will set it on next tick; show loading
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }
  return <Outlet />;
}
