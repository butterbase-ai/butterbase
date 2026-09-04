import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { bb } from '@/lib/butterbase';
import { useWorkspaceStore } from '@/lib/workspace';

const PENDING_TOKEN_KEY = 'crm.pending_invite_token';

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const [status, setStatus] = useState<'checking' | 'redirect_login' | 'accepting' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setError('Missing token');
        setStatus('error');
        return;
      }

      const { data: userResp } = await bb.auth.getUser();
      if (cancelled) return;

      if (!userResp) {
        localStorage.setItem(PENDING_TOKEN_KEY, token);
        setStatus('redirect_login');
        setTimeout(() => navigate('/login', { replace: true }), 1200);
        return;
      }

      setStatus('accepting');
      try {
        const { data, error: fnErr } = await bb.functions.invoke('accept-invite', {
          body: { token },
        });
        if (cancelled) return;
        if (fnErr) throw fnErr;
        const ws = (data as { workspace_id?: string; workspace_name?: string | null })?.workspace_id;
        if (!ws) throw new Error('No workspace returned');
        localStorage.removeItem(PENDING_TOKEN_KEY);
        setWorkspace(ws);
        toast.success(`Joined ${(data as { workspace_name?: string | null })?.workspace_name ?? 'workspace'}`);
        navigate('/companies', { replace: true });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to accept invite');
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token, navigate, setWorkspace]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md p-6 space-y-4">
        <h1 className="text-xl font-semibold">Workspace invite</h1>
        {status === 'checking' && <Skeleton className="h-6 w-3/4" />}
        {status === 'redirect_login' && (
          <p className="text-sm text-muted-foreground">
            You need to sign in first. Redirecting to login — we'll bring you right back here.
          </p>
        )}
        {status === 'accepting' && (
          <p className="text-sm text-muted-foreground">Accepting your invite...</p>
        )}
        {status === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={() => navigate('/')}>Go home</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
