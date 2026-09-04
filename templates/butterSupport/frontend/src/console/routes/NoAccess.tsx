import { useNavigate } from 'react-router-dom';
import { Button } from '@/console/components/ui/button';
import { bb } from '@/console/lib/bb';
import { Lock } from 'lucide-react';

export function NoAccess() {
  const navigate = useNavigate();
  async function signOut() {
    try { await bb.auth.signOut(); } catch { /* ignore */ }
    navigate('/login', { replace: true });
  }
  return (
    <div className="paper-grain flex h-screen items-center justify-center px-6 bg-background">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-md border border-border bg-card">
          <Lock className="h-5 w-5 text-butter" strokeWidth={1.75} />
        </div>
        <p className="eyebrow mb-3">Awaiting invitation</p>
        <h1 className="font-display text-[34px] leading-tight tracking-tight text-foreground">
          You're <em className="font-editorial italic text-butter">signed in</em>, but not on the support team yet.
        </h1>
        <p className="mt-4 font-editorial italic text-[15px] text-muted-foreground">
          Ask an admin to add you from <span className="text-foreground not-italic font-sans">Team settings</span>.
          Once invited, refresh this page and you're in.
        </p>
        <div className="mt-7">
          <Button variant="outline" onClick={signOut}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
