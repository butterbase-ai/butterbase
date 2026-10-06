import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { bb } from '@/console/lib/bb';
import type { Role } from '@/console/lib/types';

interface AuthState {
  user: { id: string; email?: string } | null;
  role: Role | null;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<AuthState>({ user: null, role: null, loading: true, error: null });

export const useAuth = () => useContext(Ctx);

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, role: null, loading: true, error: null });
  const navigate = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let unsub: (() => void) | undefined;

    async function refresh() {
      try {
        const userRes: any = await bb.auth.getUser();
        const user = userRes?.data ?? userRes?.user ?? userRes ?? null;
        if (!user || !user.id) {
          setState({ user: null, role: null, loading: false, error: null });
          if (loc.pathname !== '/login' && loc.pathname !== '/no-access') {
            navigate('/login', { replace: true });
          }
          return;
        }

        const memRes: any = await bb
          .from('memberships')
          .select('role,user_id')
          .eq('user_id', user.id)
          .limit(1);

        // Distinguish "query errored server-side" from "query returned 0 rows".
        // The SDK returns { data: null, error: {...} } on a 500; we must not
        // silently treat that as "no membership".
        if (memRes?.error) {
          const msg = memRes.error.message || String(memRes.error);
          setState({ user: { id: user.id, email: user.email }, role: null, loading: false, error: msg });
          return;
        }

        const rows = Array.isArray(memRes?.data) ? memRes.data : Array.isArray(memRes) ? memRes : [];
        const row = rows[0] ?? null;
        if (!row) {
          setState({ user: { id: user.id, email: user.email }, role: null, loading: false, error: null });
          navigate('/no-access', { replace: true });
          return;
        }
        setState({ user: { id: user.id, email: user.email }, role: row.role as Role, loading: false, error: null });

        // Setup-wizard heuristic: owner + memberships=1 + no docs sources → /setup
        if (row.role === 'owner' && loc.pathname === '/inbox') {
          try {
            const docRes: any = await bb.from('docs_sources').select('id').limit(1);
            const docs = Array.isArray(docRes?.data) ? docRes.data : Array.isArray(docRes) ? docRes : [];
            const memCountRes: any = await bb.from('memberships').select('user_id');
            const memArr = Array.isArray(memCountRes?.data) ? memCountRes.data : Array.isArray(memCountRes) ? memCountRes : [];
            const memCount = memArr.length;
            if (docs.length === 0 && memCount <= 1) navigate('/setup', { replace: true });
          } catch {
            // ignore
          }
        }
      } catch (err: any) {
        console.error('AuthGate refresh failed', err);
        setState({ user: null, role: null, loading: false, error: err?.message || 'Unknown error' });
      }
    }

    refresh();

    try {
      const onChange = (bb as any)?.auth?.onAuthStateChange;
      if (typeof onChange === 'function') {
        const sub: any = onChange.call(bb.auth, () => refresh());
        unsub = sub?.data?.subscription?.unsubscribe ?? sub?.subscription?.unsubscribe ?? sub?.unsubscribe;
      }
    } catch {
      // ignore — SDK may not expose this method; AuthGate re-runs on route changes anyway
    }

    return () => {
      try { unsub?.(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-3 bg-paper text-sm text-ink-muted">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-caramel animate-pulse-soft" />
        <span className="font-mono text-[11px] uppercase tracking-[0.22em]">loading…</span>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex h-screen items-center justify-center p-6 bg-paper">
        <div className="max-w-lg space-y-4">
          <div className="section-label">Membership lookup failed</div>
          <h1 className="font-display text-2xl tracking-tight text-ink">Couldn't load your team membership</h1>
          <p className="text-sm text-ink-muted leading-relaxed">
            The server returned an error when looking up your row in <code className="font-mono text-caramel-deep">memberships</code>. You're authenticated as{' '}
            <span className="text-ink font-medium">{state.user?.email || state.user?.id}</span>, but something on the backend is preventing the read.
          </p>
          <pre className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 font-mono text-xs whitespace-pre-wrap text-destructive">
            {state.error}
          </pre>
          <p className="text-sm text-ink-muted leading-relaxed">
            Common causes: (1) the post-auth hook didn't insert your owner row yet, or (2) the RLS policy on the
            <code className="font-mono text-caramel-deep"> memberships </code> table is recursive — a policy like
            <code className="font-mono text-caramel-deep"> EXISTS (SELECT 1 FROM memberships WHERE …) </code> on the same table will 500. Check the function logs / RLS config, then refresh.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-md border border-rule px-4 py-1.5 text-sm text-ink hover:bg-paper-warm transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
