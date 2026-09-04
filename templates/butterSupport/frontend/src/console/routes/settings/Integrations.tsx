import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { Badge } from '@/console/components/ui/badge';
import { SettingsPage } from '@/console/components/SettingsPage';
import { toast } from '@/console/components/ui/toast';
import { confirm } from '@/console/components/ui/confirm';

type Toolkit = { slug: string; name: string; description: string };

const CURATED: Toolkit[] = [
  { slug: 'gmail', name: 'Gmail', description: 'Send founder replies from your Google account when a draft is approved.' },
  { slug: 'slack', name: 'Slack', description: 'Post escalations and ticket alerts to a team channel.' },
];

type Connection = {
  id: string;
  toolkit_slug: string;
  status?: string;
  connected_at?: string;
};

const REDIRECT_PATH = '/settings/integrations';

function redirectUrl() {
  return `${window.location.origin}${REDIRECT_PATH}?connected=1`;
}

export function IntegrationsSettings() {
  const qc = useQueryClient();
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['integration_connections'],
    queryFn: async () => {
      const res = await bb.integrations.listConnections();
      return (res.data ?? []) as Connection[];
    },
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('connected') === '1') {
      url.searchParams.delete('connected');
      window.history.replaceState({}, '', url.toString());
      qc.invalidateQueries({ queryKey: ['integration_connections'] });
    }
  }, [qc]);

  async function connect(slug: string) {
    setBusySlug(slug);
    try {
      const res = await bb.integrations.connect(slug, { redirectUrl: redirectUrl() });
      const authUrl = res.data?.authUrl;
      if (!authUrl) throw new Error('No authUrl returned. Has the toolkit been enabled for this app?');
      window.location.href = authUrl;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/not_configured|not configured|not enabled/i.test(msg)) {
        toast.error(`${slug} hasn't been enabled for this app yet. An admin needs to run \`manage_integrations configure toolkit:${slug}\` once before users can connect.`, { title: 'Toolkit not enabled' });
      } else {
        toast.error(msg || 'Connect failed');
      }
      setBusySlug(null);
    }
  }

  async function disconnect(slug: string, id: string) {
    const ok = await confirm({
      title: `Disconnect ${slug}?`,
      description: 'The agent will no longer be able to act through it.',
      confirmLabel: 'Disconnect',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusySlug(slug);
    try {
      await bb.integrations.disconnect(id);
      qc.invalidateQueries({ queryKey: ['integration_connections'] });
      toast.success(`${slug} disconnected`);
    } catch (e: any) {
      toast.error(e?.message || 'Disconnect failed');
    } finally {
      setBusySlug(null);
    }
  }

  const byToolkit = new Map<string, Connection>();
  for (const c of connections) {
    const existing = byToolkit.get(c.toolkit_slug);
    const cActive = c.status?.toLowerCase() === 'active' || !c.status;
    const eActive = existing && (existing.status?.toLowerCase() === 'active' || !existing.status);
    if (!existing || (cActive && !eActive)) {
      byToolkit.set(c.toolkit_slug, c);
    }
  }

  return (
    <SettingsPage
      label="Section 11 · Integrations"
      title={<>Connected <em>accounts</em></>}
      description={
        <>
          Connect your founder accounts so the agent can act through them on approved proposals — send Gmail replies, post Slack escalations, open GitHub issues. Each connection is scoped to <em>you</em>; teammates must connect their own.
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {CURATED.map((t) => {
            const conn = byToolkit.get(t.slug);
            const isActive = !!conn && (!conn.status || conn.status.toLowerCase() === 'active');
            const busy = busySlug === t.slug;
            return (
              <Card key={t.slug} className="hover-glow">
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <CardTitle>{t.name}</CardTitle>
                  {isActive ? (
                    <Badge variant="green">Connected</Badge>
                  ) : conn ? (
                    <Badge variant="amber">{conn.status || 'pending'}</Badge>
                  ) : (
                    <Badge variant="secondary">Not connected</Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">{t.description}</p>
                  {conn?.connected_at && (
                    <p className="font-mono text-[10px] text-muted-foreground/70">
                      Connected {new Date(conn.connected_at).toLocaleString()}
                    </p>
                  )}
                  {isActive && (t.slug === 'slack' || t.slug === 'gmail') && (
                    <p className="text-[11px] text-muted-foreground">
                      <a href="/settings/escalation" className="underline hover:text-foreground">
                        Add a{t.slug === 'slack' ? ' Slack channel' : 'n email'} target →
                      </a>
                    </p>
                  )}
                  <div className="flex gap-2">
                    {conn ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => disconnect(t.slug, conn.id)}
                      >
                        {busy ? 'Working…' : 'Disconnect'}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => connect(t.slug)}>
                        {busy ? 'Redirecting…' : 'Connect'}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
        Need a toolkit that isn't listed? Browse all 1,000+ via{' '}
        <code className="text-caramel bg-butter-50 px-1.5 py-0.5 rounded">manage_integrations list_available</code> and ask an admin to enable it.
      </p>
    </SettingsPage>
  );
}
