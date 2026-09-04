import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityAvatar } from '@/components/EntityAvatar';
import { Mail, Phone, Briefcase, Building2, Link as LinkIcon, Activity as ActivityIcon, Calendar } from 'lucide-react';
import { bb } from '@/lib/butterbase';
import { listEntities, entityToMeeting, getEntity, entityToCompany } from '@/lib/substrate';
import type { Person, Activity, Company, Meeting } from '@/lib/types';

interface Props {
  person: Person | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function fullName(p: Person): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || 'Unnamed';
}

function activityLabel(a: Activity): string {
  switch (a.kind) {
    case 'email.received': return 'Email received';
    case 'email.sent': return 'Email sent';
    case 'note': return 'Note';
    case 'call': return 'Call';
    default: return a.kind;
  }
}

function activitySnippet(a: Activity): string | null {
  const p = a.payload as any;
  if (!p) return null;
  if (a.kind.startsWith('email.')) {
    return p.subject || p.snippet || null;
  }
  return p.body || p.text || null;
}

export function PersonDialog({ person, open, onOpenChange }: Props) {
  const personId = person?.id;
  const companyId = person?.company_id;

  const { data: company } = useQuery({
    queryKey: ['person_company', companyId],
    enabled: !!companyId && open,
    queryFn: async (): Promise<Company | null> => {
      const e = await getEntity(companyId!);
      return e ? entityToCompany(e) : null;
    },
  });

  const { data: activities = [], isLoading: actLoading } = useQuery({
    queryKey: ['person_activities', personId],
    enabled: !!personId && open,
    queryFn: async (): Promise<Activity[]> => {
      const { data, error } = await bb
        .from<Activity>('activities')
        .select('*')
        .eq('entity_type', 'person')
        .eq('entity_id', personId!)
        .order('created_at', { ascending: false })
        .limit(15);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: meetings = [] } = useQuery({
    queryKey: ['person_meetings_substrate', personId],
    enabled: !!personId && open,
    queryFn: async (): Promise<Meeting[]> => {
      const events = await listEntities('event', { limit: 200 });
      return events
        .filter((e) => !e.attrs?.deleted_at)
        .filter((e) => {
          const ids: string[] = Array.isArray(e.attrs?.attendee_entity_ids) ? e.attrs.attendee_entity_ids : [];
          return ids.includes(personId!);
        })
        .map(entityToMeeting)
        .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''))
        .slice(0, 10);
    },
  });

  if (!person) return null;
  const name = fullName(person);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 font-display tracking-tight">
            <EntityAvatar objectId={person.avatar_object_id} fallback={name} />
            <div className="min-w-0 flex-1">
              <div className="text-[20px] leading-tight text-foreground">{name}</div>
              {person.title && (
                <div className="font-editorial italic text-[13px] text-muted-foreground mt-0.5">
                  {person.title}
                </div>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Contact details */}
          <section className="card-flat p-4 space-y-2.5">
            {person.email && (
              <div className="flex items-center gap-2 text-[13px]">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a href={`mailto:${person.email}`} className="text-butter hover:underline break-all">
                  {person.email}
                </a>
              </div>
            )}
            {person.phone && (
              <div className="flex items-center gap-2 text-[13px]">
                <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a href={`tel:${person.phone}`} className="text-foreground hover:underline">
                  {person.phone}
                </a>
              </div>
            )}
            {company && (
              <div className="flex items-center gap-2 text-[13px]">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a href={`/companies/${company.id}`} className="text-foreground hover:underline">
                  {company.name}
                </a>
                {company.industry && (
                  <span className="font-editorial italic text-muted-foreground">· {company.industry}</span>
                )}
              </div>
            )}
            {person.title && (
              <div className="flex items-center gap-2 text-[13px]">
                <Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-foreground">{person.title}</span>
              </div>
            )}
            {person.linkedin_url && (
              <div className="flex items-center gap-2 text-[13px]">
                <LinkIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a
                  href={person.linkedin_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-butter hover:underline break-all"
                >
                  {person.linkedin_url}
                </a>
              </div>
            )}
            {!person.email && !person.phone && !company && !person.linkedin_url && !person.title && (
              <p className="font-editorial italic text-[13px] text-muted-foreground">
                No contact details on file yet.
              </p>
            )}
          </section>

          {/* Recent meetings */}
          {meetings.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="eyebrow">Recent meetings · {meetings.length}</p>
              </div>
              <ul className="space-y-1.5">
                {meetings.map((m) => (
                  <li key={m.id} className="card-flat px-3 py-2 flex items-center gap-3">
                    <span className="font-mono text-[11px] text-muted-foreground num w-28 shrink-0">
                      {format(new Date(m.starts_at), 'MMM d, h:mm a')}
                    </span>
                    <span className="text-[13px] text-foreground truncate flex-1">{m.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Recent activities */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="eyebrow">Recent activity</p>
            </div>
            {actLoading ? (
              <Skeleton className="h-20" />
            ) : activities.length === 0 ? (
              <p className="font-editorial italic text-[13px] text-muted-foreground">
                No activity logged yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {activities.map((a) => {
                  const snippet = activitySnippet(a);
                  return (
                    <li key={a.id} className="card-flat px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[10.5px] text-muted-foreground num shrink-0">
                          {formatDistanceToNowStrict(new Date(a.created_at), { addSuffix: true })}
                        </span>
                        <span className="text-[12.5px] text-foreground/85">{activityLabel(a)}</span>
                      </div>
                      {snippet && (
                        <p className="mt-1 text-[12.5px] text-muted-foreground line-clamp-2">
                          {snippet}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
