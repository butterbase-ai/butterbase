import { formatDistanceToNowStrict } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { useActivities } from '@/hooks/useActivities';
import type { Activity } from '@/lib/types';

function humanizeActivity(activity: Activity): string {
  const { kind, payload } = activity;

  switch (kind) {
    case 'company.created':
      return `created company "${(payload?.name as string) || ''}"`;
    case 'company.updated': {
      const fields = (payload?.fields as string[]) || [];
      return `updated company ${fields.join(', ') || 'info'}`;
    }
    case 'person.created':
      return `added person "${(payload?.name as string) || ''}"`;
    case 'person.updated': {
      const fields = (payload?.fields as string[]) || [];
      return `updated person ${fields.join(', ') || 'info'}`;
    }
    case 'deal.created':
      return `created deal "${(payload?.name as string) || ''}"`;
    case 'deal.stage_changed': {
      const from = payload?.from as string;
      const to = payload?.to as string;
      return `moved deal from ${from || 'unknown'} to ${to || 'unknown'}`;
    }
    case 'deal.updated':
      return 'updated deal';
    case 'deal.deleted':
      return 'deleted deal';
    case 'note.created':
      return 'added a note';
    case 'note.updated':
      return 'updated a note';
    case 'meeting.created':
      return 'scheduled a meeting';
    case 'meeting.updated':
      return 'updated a meeting';
    case 'social_post_published':
    case 'social_post_failed': {
      const preview = (payload?.body_preview as string) || '';
      const channels = (payload?.channels as Record<string, string>) || {};
      const ok = Object.entries(channels).filter(([, s]) => s === 'sent').map(([c]) => c);
      const failed = Object.entries(channels).filter(([, s]) => s === 'failed').map(([c]) => c);
      const verb = kind === 'social_post_published' ? 'published' : 'failed';
      const summary = [
        ok.length > 0 ? `sent: ${ok.join(', ')}` : null,
        failed.length > 0 ? `failed: ${failed.join(', ')}` : null,
      ].filter(Boolean).join(' · ');
      return `${verb} social post${preview ? ` "${preview.slice(0, 60)}…"` : ''}${summary ? ` (${summary})` : ''}`;
    }
    case 'social_post_removed_from_platform': {
      const channel = (payload?.channel as string) || 'a channel';
      return `removed social post from ${channel}`;
    }
    default:
      return kind;
  }
}

export default function ActivityFeed() {
  const { data: activities = [], isLoading } = useActivities();

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 05 · Ledger</p>
          <h1 className="page-title">
            Activity <em>as it happens</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            An honest, append-only record of every change made in this workspace.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : activities.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <h3 className="font-medium">No activity yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Activity will appear here as you make changes.</p>
          </div>
        ) : (
          <ol className="relative max-w-3xl pl-6">
            <span className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
            {activities.map((act, i) => (
              <li key={act.id} className="relative pb-5 last:pb-0">
                <span className="absolute -left-[19px] top-1.5 h-3 w-3 rounded-full border-2 border-background bg-butter ring-1 ring-border" />
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground num">
                    #{String(activities.length - i).padStart(3, '0')}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground truncate">
                    {act.actor_user_id.slice(0, 8)}
                  </span>
                  <span className="font-display text-[16px] tracking-tight text-foreground">
                    {humanizeActivity(act)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 font-editorial italic text-[12.5px] text-muted-foreground">
                  <span>{act.entity_type}</span>
                  <span>·</span>
                  <span>{formatDistanceToNowStrict(new Date(act.created_at), { addSuffix: true })}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
