import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { Select } from '@/console/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import type { EscalationTarget } from '@/console/lib/types';
import { SettingsPage } from '@/console/components/SettingsPage';
import { toast } from '@/console/components/ui/toast';
import { confirm } from '@/console/components/ui/confirm';

export function EscalationSettings() {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<'email' | 'slack' | 'webhook'>('email');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: targets = [] } = useQuery({
    queryKey: ['escalation_targets'],
    queryFn: async () => {
      const res: any = await bb.from('escalation_targets').select('*').order('created_at', { ascending: false });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as EscalationTarget[];
    },
  });

  const { data: connections } = useQuery({
    queryKey: ['integration_connections'],
    queryFn: async () => {
      const res: any = await bb.integrations.listConnections();
      return (res?.data ?? []) as Array<{ id: string; toolkit_slug: string; status?: string }>;
    },
  });
  const isActive = (slug: string) =>
    !!(connections || []).find((c) => c.toolkit_slug === slug && (!c.status || c.status.toLowerCase() === 'active'));
  const gmailConnected = isActive('gmail');
  const slackConnected = isActive('slack');

  type SlackChannel = { id: string; name: string; is_private?: boolean };
  const { data: slackChannels = [], isLoading: slackChannelsLoading, error: slackChannelsError } = useQuery({
    queryKey: ['slack_channels'],
    enabled: channel === 'slack' && slackConnected,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res: any = await bb.integrations.execute('SLACK_LIST_ALL_CHANNELS', {
        types: 'public_channel,private_channel',
        limit: 200,
      });
      const raw = res?.data?.data?.channels || res?.data?.channels || [];
      const list: SlackChannel[] = raw
        .filter((c: any) => c && c.id && c.name && !c.is_archived)
        .map((c: any) => ({ id: c.id, name: c.name, is_private: !!c.is_private }))
        .sort((a: SlackChannel, b: SlackChannel) => a.name.localeCompare(b.name));
      return list;
    },
  });

  async function add() {
    setBusy(true);
    try {
      if (channel === 'email' && !gmailConnected) {
        toast.warning('Connect Gmail in Settings → Integrations before adding an email target. The escalation will be sent from your Google account.');
        return;
      }
      const userRes: any = await bb.auth.getUser();
      const connectedUserId = userRes?.data?.id || userRes?.id || userRes?.user?.id || null;
      if ((channel === 'email' || channel === 'slack') && !connectedUserId) {
        toast.error('Could not resolve your user id — try signing out and back in.');
        return;
      }
      let config: Record<string, unknown>;
      if (channel === 'slack') {
        if (!slackConnected) {
          toast.warning('Connect Slack in Settings → Integrations before adding a Slack target.');
          return;
        }
        const picked = slackChannels.find((c) => c.id === target);
        config = {
          channel_id: target,
          channel_name: picked?.name,
          connected_user_id: connectedUserId,
        };
      } else if (channel === 'email') {
        config = { to: target, connected_user_id: connectedUserId };
      } else {
        config = { url: target };
      }
      await bb.from('escalation_targets').insert({ channel, config, active: true });
      setTarget('');
      qc.invalidateQueries({ queryKey: ['escalation_targets'] });
      toast.success('Escalation target added');
    } catch (e: any) {
      toast.error(e?.message || 'Add failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(target_id: string) {
    if (!(await confirm({ title: 'Remove target?', description: 'Escalations will stop firing to this destination.', confirmLabel: 'Remove', variant: 'destructive' }))) return;
    try {
      await bb.from('escalation_targets').delete().eq('id', target_id);
      qc.invalidateQueries({ queryKey: ['escalation_targets'] });
      toast.success('Target removed');
    } catch (e: any) {
      toast.error(e?.message || 'Remove failed');
    }
  }

  return (
    <SettingsPage
      label="Escalation"
      title={<>When the agent calls for <em>backup</em></>}
      description="Every active target receives every escalation. Add as many channels as you want — they all fire in parallel."
    >
      <Card>
        <CardHeader><CardTitle>Add a target</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {channel === 'email' && !gmailConnected && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Email escalation sends through your connected Gmail account.{' '}
              <a href="/settings/integrations" className="underline">Connect Gmail</a> first.
            </div>
          )}
          {channel === 'slack' && !slackConnected && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Slack escalation posts through your connected Slack workspace.{' '}
              <a href="/settings/integrations" className="underline">Connect Slack</a> first.
            </div>
          )}
          {channel === 'slack' && slackConnected && slackChannelsError && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Couldn't load Slack channels — paste a channel ID (e.g. C0123ABCD) instead.
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value as any);
                setTarget('');
              }}
              className="w-40"
            >
              <option value="email">Email</option>
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
            </Select>
            {channel === 'slack' && slackConnected && !slackChannelsError ? (
              <Select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="flex-1 min-w-[200px]"
                disabled={slackChannelsLoading}
              >
                <option value="">
                  {slackChannelsLoading ? 'Loading channels…' : 'Select a channel…'}
                </option>
                {slackChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.is_private ? '🔒 ' : '#'}{c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={channel === 'slack' ? 'C0123ABCD' : channel === 'email' ? 'oncall@company.com' : 'https://hooks…'}
                className="flex-1 min-w-[200px]"
              />
            )}
            <Button onClick={add} disabled={!target || busy}>Add target</Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <div className="section-label mb-3">Targets · {targets.length}</div>
        <div className="rounded-2xl border border-rule-soft bg-paper-soft divide-y divide-[rgb(244_236_221/0.06)]">
          {targets.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 text-sm min-w-0">
                <div className="font-medium capitalize text-foreground">{t.channel}</div>
                <pre className="font-mono text-[11px] text-muted-foreground truncate">
                  {t.channel === 'slack' && (t.config as any)?.channel_name
                    ? `#${(t.config as any).channel_name}`
                    : t.channel === 'email' && (t.config as any)?.to
                    ? (t.config as any).to
                    : JSON.stringify(t.config)}
                </pre>
              </div>
              <Button size="sm" variant="ghost" onClick={() => remove(t.id)}>Remove</Button>
            </div>
          ))}
          {targets.length === 0 && <div className="p-4 text-sm text-muted-foreground">No escalation targets yet.</div>}
        </div>
      </div>
    </SettingsPage>
  );
}
