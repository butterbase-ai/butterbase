import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { bb } from '@/lib/butterbase';

type GateState = 'loading' | 'authed' | 'guest' | 'denied';

export function AuthGuard() {
  const [state, setState] = useState<GateState>('loading');
  const location = useLocation();
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function runAllowlist(userId: string, email: string | null) {
      if (checkedFor.current === userId) return;
      checkedFor.current = userId;
      try {
        const { data, error } = await bb.functions.invoke('check-allowlist', { body: { email } });
        if (error) {
          // If the gate function itself errors, fail open so an outage doesn't lock everyone out.
          console.warn('check-allowlist failed; allowing through', error);
          if (!cancelled) setState('authed');
          return;
        }
        const allowed = (data as any)?.allowed !== false;
        if (!allowed) {
          await bb.auth.signOut().catch(() => undefined);
          if (!cancelled) setState('denied');
          return;
        }
        if (!cancelled) setState('authed');
      } catch (e) {
        console.warn('check-allowlist threw; allowing through', e);
        if (!cancelled) setState('authed');
      }
    }

    bb.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const uid = (data as any)?.id ?? null;
      const email = (data as any)?.email ?? null;
      if (uid) {
        runAllowlist(uid, email);
      } else {
        setState('guest');
      }
    });

    const sub = bb.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      const uid = (session as any)?.user?.id ?? null;
      const email = (session as any)?.user?.email ?? null;
      if (uid) {
        runAllowlist(uid, email);
      } else {
        checkedFor.current = null;
        setState('guest');
      }
    });
    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (state === 'denied') {
    return <Navigate to="/login?denied=1" replace state={{ from: location }} />;
  }
  if (state === 'guest') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
