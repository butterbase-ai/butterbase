import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatDistanceToNowStrict } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, Pause, X, Trash2, Mail, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  useCampaigns,
  useCampaignLists,
  useDeleteCampaignList,
  useCampaign,
  useCampaignList,
  useCampaignListMembers,
  useCampaignSends,
  useCampaignControl,
  useStartCampaign,
} from '@/hooks/useCampaigns';
import { NewCampaignDialog } from '@/components/NewCampaignDialog';
import type { Campaign, CampaignSend, CampaignListMember } from '@/lib/types';

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-butter/20 text-foreground',
  paused: 'bg-amber-100 text-amber-900',
  completed: 'bg-emerald-100 text-emerald-900',
  cancelled: 'bg-zinc-200 text-zinc-700',
};

export default function CampaignsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'campaigns';
  const campaignId = params.get('campaign');
  const listId = params.get('list_id');

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 08 · Outreach</p>
          <h1 className="page-title">
            Campaigns <em>&amp; audiences</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Save an AI search as an audience, then drip a personalised note out through your Gmail — throttled, capped, traceable.
          </p>
        </div>
        <div className="flex items-center gap-3 self-end">
          <NewCampaignDialog defaultListId={params.get('list') ?? undefined} />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {campaignId ? (
          <CampaignDetail campaignId={campaignId} onBack={() => { params.delete('campaign'); setParams(params); }} />
        ) : listId ? (
          <ListDetail listId={listId} onBack={() => { params.delete('list_id'); setParams(params); }} />
        ) : (
          <Tabs value={tab} onValueChange={(v) => { params.set('tab', v); setParams(params); }}>
            <TabsList>
              <TabsTrigger value="campaigns" className="gap-1.5"><Mail className="h-3.5 w-3.5" /> Campaigns</TabsTrigger>
              <TabsTrigger value="lists" className="gap-1.5"><Users className="h-3.5 w-3.5" /> Audience lists</TabsTrigger>
            </TabsList>
            <TabsContent value="campaigns" className="mt-4">
              <CampaignsTable onOpen={(id) => { params.set('campaign', id); setParams(params); }} />
            </TabsContent>
            <TabsContent value="lists" className="mt-4">
              <ListsTable onOpen={(id) => { params.set('list_id', id); setParams(params); }} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

function CampaignsTable({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: campaigns, isLoading } = useCampaigns();
  if (isLoading) {
    return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }
  if (!campaigns || campaigns.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h3 className="font-medium">No campaigns yet</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">Save an audience list via AI search, then click “New campaign”.</p>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Progress</TableHead>
          <TableHead className="text-right">Daily cap</TableHead>
          <TableHead className="text-right">Throttle</TableHead>
          <TableHead className="text-right">Last sent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {campaigns.map((c) => (
          <TableRow key={c.id} className="cursor-pointer hover:bg-butter/[0.04]" onClick={() => onOpen(c.id)}>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell>
              <Badge className={STATUS_TONE[c.status] ?? ''}>{c.status}</Badge>
            </TableCell>
            <TableCell className="text-right text-sm">
              {c.sent_count}/{c.total_count}
              {c.failed_count > 0 && <span className="text-coral"> · {c.failed_count} failed</span>}
            </TableCell>
            <TableCell className="text-right text-sm num font-mono">{c.daily_limit}/day</TableCell>
            <TableCell className="text-right text-sm num font-mono">{Math.round(c.throttle_seconds / 60)}m</TableCell>
            <TableCell className="text-right text-sm text-muted-foreground">
              {c.last_sent_at ? formatDistanceToNowStrict(new Date(c.last_sent_at), { addSuffix: true }) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ListsTable({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: lists, isLoading } = useCampaignLists();
  const del = useDeleteCampaignList();
  if (isLoading) {
    return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }
  if (!lists || lists.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h3 className="font-medium">No saved lists yet</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">Open AI search (⌘K), describe the audience, and hit “Save as list”.</p>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Members</TableHead>
          <TableHead className="text-right">Created</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {lists.map((l) => (
          <TableRow key={l.id} className="cursor-pointer hover:bg-butter/[0.04]" onClick={() => onOpen(l.id)}>
            <TableCell className="font-medium">{l.name}</TableCell>
            <TableCell className="text-sm">{l.entity_type}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{l.source === 'ai_search' ? 'AI search' : 'manual'}</TableCell>
            <TableCell className="text-right text-sm num font-mono">{l.member_count}</TableCell>
            <TableCell className="text-right text-sm text-muted-foreground">
              {formatDistanceToNowStrict(new Date(l.created_at), { addSuffix: true })}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-coral"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete list “${l.name}”? Campaigns using it will block delete.`)) return;
                  try {
                    await del.mutateAsync(l.id);
                    toast.success('List deleted');
                  } catch (e: any) { toast.error(e?.message ?? 'Failed to delete'); }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CampaignDetail({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const { data: campaign } = useCampaign(campaignId);
  const { data: sends } = useCampaignSends(campaignId);
  const ctrl = useCampaignControl();
  const start = useStartCampaign();

  const grouped = useMemo(() => {
    const out = { queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const s of (sends ?? [])) out[s.status] = (out[s.status] ?? 0) + 1;
    return out;
  }, [sends]);

  if (!campaign) return <Skeleton className="h-40" />;

  async function act(action: 'pause' | 'resume' | 'cancel') {
    try {
      await ctrl.mutateAsync({ campaign_id: campaign!.id, action });
      toast.success(`Campaign ${action}d`);
    } catch (e: any) { toast.error(e?.message ?? `Failed to ${action}`); }
  }

  async function startNow() {
    try { await start.mutateAsync(campaign!.id); toast.success('Campaign started'); }
    catch (e: any) { toast.error(e?.message ?? 'Failed to start'); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2 text-muted-foreground">← All campaigns</Button>
          <h2 className="font-display text-2xl tracking-tight">{campaign.name}</h2>
          <div className="mt-1 flex items-center gap-2">
            <Badge className={STATUS_TONE[campaign.status] ?? ''}>{campaign.status}</Badge>
            <span className="text-[12.5px] text-muted-foreground font-mono">
              {campaign.sent_count}/{campaign.total_count} sent · cap {campaign.daily_limit}/day · throttle {Math.round(campaign.throttle_seconds / 60)}m
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {campaign.status === 'draft' && (
            <Button onClick={startNow} className="gap-1.5 bg-foreground text-background hover:bg-foreground/85">
              <Play className="h-3.5 w-3.5" /> Start
            </Button>
          )}
          {campaign.status === 'active' && (
            <Button variant="outline" onClick={() => act('pause')} className="gap-1.5">
              <Pause className="h-3.5 w-3.5" /> Pause
            </Button>
          )}
          {campaign.status === 'paused' && (
            <Button onClick={() => act('resume')} className="gap-1.5 bg-foreground text-background hover:bg-foreground/85">
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          )}
          {['active', 'paused', 'draft'].includes(campaign.status) && (
            <Button variant="outline" onClick={() => act('cancel')} className="gap-1.5 text-coral hover:text-coral">
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {(['queued', 'sending', 'sent', 'failed', 'cancelled'] as const).map((k) => (
          <div key={k} className="rounded-lg border border-border bg-card/40 p-3">
            <p className="eyebrow !text-[10px]">{k}</p>
            <p className="mt-1 font-mono text-xl num">{grouped[k]}</p>
          </div>
        ))}
      </div>

      <SendsTable sends={sends ?? []} />

      <details className="rounded-lg border border-border bg-card/40 p-3 text-[12.5px]">
        <summary className="cursor-pointer eyebrow !text-[10px]">Preview · subject &amp; body template</summary>
        <div className="mt-2 space-y-2">
          <p className="font-medium">{campaign.subject}</p>
          <pre className="whitespace-pre-wrap font-mono text-[12px] text-muted-foreground">{campaign.body_template}</pre>
        </div>
      </details>
    </div>
  );
}

function SendsTable({ sends }: { sends: CampaignSend[] }) {
  if (sends.length === 0) {
    return <p className="text-[13px] text-muted-foreground italic font-editorial">No sends materialised yet. Start the campaign to queue them.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Recipient</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Scheduled</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sends.slice(0, 200).map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-mono text-[12px]">{s.email}</TableCell>
            <TableCell><Badge className={STATUS_TONE[s.status] ?? ''}>{s.status}</Badge></TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatDistanceToNowStrict(new Date(s.scheduled_for), { addSuffix: true })}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {s.sent_at ? formatDistanceToNowStrict(new Date(s.sent_at), { addSuffix: true }) : '—'}
            </TableCell>
            <TableCell className="text-[12px] text-coral max-w-xs truncate">{s.error ?? ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ListDetail({ listId, onBack }: { listId: string; onBack: () => void }) {
  const { data: list } = useCampaignList(listId);
  const { data: members, isLoading } = useCampaignListMembers(listId);

  if (!list) return <Skeleton className="h-40" />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2 text-muted-foreground">← All lists</Button>
          <h2 className="font-display text-2xl tracking-tight">{list.name}</h2>
          <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground font-mono">
            <Badge variant="secondary">{list.entity_type}</Badge>
            <span>{list.member_count} members</span>
            <span>·</span>
            <span>{list.source === 'ai_search' ? 'AI search' : 'manual'}</span>
            <span>·</span>
            <span>created {formatDistanceToNowStrict(new Date(list.created_at), { addSuffix: true })}</span>
          </div>
        </div>
      </div>

      <MembersTable members={members ?? []} loading={isLoading} entityType={list.entity_type} />
    </div>
  );
}

function MembersTable({ members, loading, entityType }: { members: CampaignListMember[]; loading: boolean; entityType: 'people' | 'companies' }) {
  if (loading) {
    return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  }
  if (members.length === 0) {
    return <p className="text-[13px] text-muted-foreground italic font-editorial">No members in this list yet.</p>;
  }
  const detailBase = entityType === 'companies' ? '/companies' : '/people';
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Company</TableHead>
          <TableHead>Email</TableHead>
          <TableHead className="text-right">Added</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.slice(0, 500).map((m) => {
          const vars = (m.vars_snapshot ?? {}) as Record<string, string | null | undefined>;
          const first = vars.first_name ?? '';
          const last = vars.last_name ?? '';
          const name = [first, last].filter(Boolean).join(' ').trim() || m.entity_id;
          return (
            <TableRow key={m.id}>
              <TableCell className="font-medium">
                <Link to={`${detailBase}/${m.entity_id}`} className="hover:underline">{name}</Link>
              </TableCell>
              <TableCell className="text-sm">{vars.title ?? '—'}</TableCell>
              <TableCell className="text-sm">{vars.company_name ?? '—'}</TableCell>
              <TableCell className="font-mono text-[12px]">{m.email_snapshot ?? '—'}</TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {formatDistanceToNowStrict(new Date(m.added_at), { addSuffix: true })}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Keep Campaign type imported for clarity in detail signatures.
export type _CampaignTypeMarker = Campaign;
