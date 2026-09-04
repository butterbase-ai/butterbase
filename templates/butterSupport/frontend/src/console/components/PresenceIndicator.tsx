import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { bb } from '@/console/lib/bb';
import { useAuth } from '@/console/components/AuthGate';

type Viewer = { user_id: string | null; name: string };

export function PresenceIndicator({ ticketId }: { ticketId: string }) {
  const { user } = useAuth();
  const [viewers, setViewers] = useState<Viewer[]>([]);

  useEffect(() => {
    if (!user?.id) return;
    const rt = (bb as any).realtime;
    if (!rt?.trackPresence) return;

    let sub: { unsubscribe?: () => void } | undefined;
    try { rt.connect?.(); } catch { /* ignore */ }

    const myName = user.email || user.id;
    try { rt.trackPresence({ ticket_id: ticketId, user_id: user.id, name: myName }); } catch { /* ignore */ }

    try {
      sub = rt.onPresence?.((evt: any) => {
        const clients: any[] = Array.isArray(evt?.clients) ? evt.clients : [];
        if (clients.length === 0 && evt?.type !== 'state') return;
        const others: Viewer[] = [];
        const seen = new Set<string>();
        for (const c of clients) {
          const md = c?.metadata || {};
          if (md.ticket_id !== ticketId) continue;
          if (c?.user_id && c.user_id === user.id) continue;
          const key = c?.user_id || c?.client_id || JSON.stringify(md);
          if (seen.has(key)) continue;
          seen.add(key);
          others.push({ user_id: c?.user_id ?? null, name: String(md.name || c?.user_id || 'teammate') });
        }
        setViewers(others);
      });
    } catch { /* ignore */ }

    return () => {
      try { rt.updatePresence?.({ ticket_id: null, user_id: user.id, name: myName }); } catch { /* ignore */ }
      try { sub?.unsubscribe?.(); } catch { /* ignore */ }
    };
  }, [ticketId, user?.id, user?.email]);

  if (viewers.length === 0) return null;

  const label =
    viewers.length === 1
      ? `${viewers[0].name} is viewing`
      : viewers.length === 2
        ? `${viewers[0].name} and ${viewers[1].name} are viewing`
        : `${viewers[0].name} and ${viewers.length - 1} others are viewing`;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-positive/30 bg-positive/10 px-2.5 py-1 text-[10px] uppercase tracking-wider font-mono text-positive"
      title={viewers.map((v) => v.name).join(', ')}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inset-0 rounded-full bg-positive animate-pulse-soft" />
      </span>
      <Eye className="h-3 w-3" />
      <span className="truncate max-w-[14rem] normal-case tracking-normal text-foreground/85">{label}</span>
    </div>
  );
}
