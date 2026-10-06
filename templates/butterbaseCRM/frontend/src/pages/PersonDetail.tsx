import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Trash2, Pencil, X } from 'lucide-react';
import { useEditMode } from '@/lib/editMode';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EntityAvatar } from '@/components/EntityAvatar';
import { InlineEditCell } from '@/components/InlineEditCell';
import { EnrichButton } from '@/components/EnrichButton';
import { NotesPanel } from '@/components/NotesPanel';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { usePerson } from '@/hooks/usePerson';
import { useUpdatePerson, useDeletePerson } from '@/hooks/usePeople';
import { useCompanies } from '@/hooks/useCompanies';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import { bb } from '@/lib/butterbase';
import { listEntities, getEntity, entityToMeeting } from '@/lib/substrate';
import type { Person, Activity, Meeting } from '@/lib/types';

// Keys we already render explicitly above the custom-fields/extra section. Any
// other key on entity.attrs is surfaced under "Other attributes" so detail
// pages don't silently swallow data that ingest/agents wrote.
const KNOWN_PERSON_ATTR_KEYS = new Set([
  'first_name', 'last_name', 'email', 'phone', 'title', 'avatar_object_id',
  'linkedin_url', 'enrichment_status', 'enriched_at', 'company_id',
  'custom_fields', 'deleted_at',
]);

type EditableField = 'first_name' | 'last_name' | 'email' | 'phone' | 'title' | 'linkedin_url';

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
  if (a.kind.startsWith('email.')) return p.subject || p.snippet || null;
  return p.body || p.text || null;
}

export default function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editModePref] = useEditMode();
  const [toggleEditing, setToggleEditing] = useState(false);
  const fieldsLocked = editModePref === 'toggle' && !toggleEditing;
  const { data: person, isLoading } = usePerson(id || '');
  const { data: companies } = useCompanies();
  const updateMut = useUpdatePerson();
  const deleteMut = useDeletePerson();
  const cvLookup = useCustomValueLookup('people');

  const { data: rawAttrs } = useQuery({
    queryKey: ['person_raw_attrs', id],
    enabled: !!id,
    queryFn: async () => {
      const e = await getEntity(id!);
      return (e?.attrs ?? {}) as Record<string, unknown>;
    },
  });

  const cfSlugs = useMemo(
    () => new Set(cvLookup.fields.map((f) => f.slug)),
    [cvLookup.fields],
  );

  const extraAttrs = useMemo(() => {
    if (!rawAttrs) return [] as Array<[string, unknown]>;
    return Object.entries(rawAttrs).filter(([k, v]) => {
      if (KNOWN_PERSON_ATTR_KEYS.has(k)) return false;
      if (k === 'name') return false;
      if (cfSlugs.has(k)) return false;
      if (v == null) return false;
      return true;
    });
  }, [rawAttrs, cfSlugs]);

  const company = useMemo(() => {
    if (!person?.company_id || !companies) return null;
    return companies.find((c) => c.id === person.company_id) ?? null;
  }, [person?.company_id, companies]);

  const { data: activities = [], isLoading: actLoading } = useQuery({
    queryKey: ['person_activities', id],
    enabled: !!id,
    queryFn: async (): Promise<Activity[]> => {
      const { data, error } = await bb
        .from<Activity>('activities')
        .select('*')
        .eq('entity_type', 'person')
        .eq('entity_id', id!)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: meetings = [] } = useQuery({
    queryKey: ['person_meetings_substrate', id],
    enabled: !!id,
    queryFn: async (): Promise<Meeting[]> => {
      const events = await listEntities('event', { limit: 200 });
      return events
        .filter((e) => !e.attrs?.deleted_at)
        .filter((e) => {
          const ids: string[] = Array.isArray(e.attrs?.attendee_entity_ids) ? e.attrs.attendee_entity_ids : [];
          return ids.includes(id!);
        })
        .map(entityToMeeting)
        .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''))
        .slice(0, 20);
    },
  });

  async function saveField(field: EditableField, value: string) {
    if (!person?.id) return;
    try {
      const patch: Partial<Person> = { [field]: value === '' ? null : value } as Partial<Person>;
      await updateMut.mutateAsync({ id: person.id, patch });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  }

  async function handleDelete() {
    if (!person?.id) return;
    const label = fullName(person);
    if (!window.confirm(`Delete ${label}? This can't be undone from the UI.`)) return;
    try {
      await deleteMut.mutateAsync(person.id);
      toast.success(`Deleted ${label}`);
      navigate('/people');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function saveCompany(value: string) {
    if (!person?.id) return;
    const trimmed = value.trim();
    const match = !trimmed
      ? null
      : companies?.find((c) =>
          c.name.toLowerCase() === trimmed.toLowerCase() ||
          (c.domain && c.domain.toLowerCase() === trimmed.toLowerCase()),
        );
    if (trimmed && !match) {
      toast.error(`No company matches "${trimmed}". Create it first from Companies.`);
      throw new Error('no_match');
    }
    try {
      await updateMut.mutateAsync({ id: person.id, patch: { company_id: match?.id ?? null } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  }

  if (!id) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Person not found</h1>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col gap-6 px-6 py-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!person || !person.id) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Person not found</h1>
      </div>
    );
  }

  const name = fullName(person);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="flex items-start gap-4">
          <EntityAvatar objectId={person.avatar_object_id} fallback={name} className="h-16 w-16" />
          <div className="flex-1 min-w-0 relative">
            <div className="absolute right-0 top-0 flex items-center gap-2">
              {editModePref === 'toggle' && (
                <Button
                  size="sm"
                  variant={toggleEditing ? 'default' : 'outline'}
                  onClick={() => setToggleEditing((v) => !v)}
                  className="gap-1.5"
                >
                  {toggleEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                  {toggleEditing ? 'Done' : 'Edit'}
                </Button>
              )}
              <EnrichButton kind="person" entityId={person.id} />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
                className="text-muted-foreground hover:text-destructive"
                title="Delete person"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-baseline gap-2 mb-1">
              <div className="text-3xl font-semibold flex items-center gap-1">
                <InlineEditCell
                  value={person.first_name}
                  placeholder="First"
                  disabled={fieldsLocked}
                  onSave={(v) => saveField('first_name', v)}
                  className="text-3xl font-semibold"
                />
                <InlineEditCell
                  value={person.last_name}
                  placeholder="Last"
                  disabled={fieldsLocked}
                  onSave={(v) => saveField('last_name', v)}
                  className="text-3xl font-semibold"
                />
              </div>
            </div>
            <div className="mt-2 grid max-w-2xl grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <FieldRow label="Title">
                <InlineEditCell value={person.title} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('title', v)} />
              </FieldRow>
              <FieldRow label="Company">
                <InlineEditCell
                  value={company?.name ?? null}
                  placeholder={person.company_id ? '—' : 'Type a company name'}
                  disabled={fieldsLocked}
                  onSave={saveCompany}
                />
              </FieldRow>
              <FieldRow label="Email">
                {(() => {
                  const status = person.email_status;
                  if (!person.email && status === 'pending') {
                    return <span className="text-muted-foreground italic text-xs">pending…</span>;
                  }
                  if (!person.email && status === 'failed') {
                    return <span className="text-muted-foreground italic text-xs" title="Email lookup failed">unavailable</span>;
                  }
                  return <InlineEditCell value={person.email} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('email', v)} />;
                })()}
              </FieldRow>
              <FieldRow label="Phone">
                <InlineEditCell value={person.phone} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('phone', v)} />
              </FieldRow>
              <FieldRow label="LinkedIn" full>
                <InlineEditCell value={person.linkedin_url} placeholder="—" type="url" disabled={fieldsLocked} onSave={(v) => saveField('linkedin_url', v)} />
              </FieldRow>
              {person.enrichment_status && (
                <FieldRow label="Enrichment">
                  <span className="text-sm">
                    {person.enrichment_status}
                    {person.enriched_at && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        · {formatDistanceToNowStrict(new Date(person.enriched_at), { addSuffix: true })}
                      </span>
                    )}
                  </span>
                </FieldRow>
              )}
            </div>
            {company && (
              <div className="mt-2 text-xs text-muted-foreground">
                <Link to={`/companies/${company.id}`} className="text-blue-600 hover:underline">
                  Open {company.name} →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="meetings">Meetings</TabsTrigger>
            <TabsTrigger value="attachments">Attachments</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            {cvLookup.fields.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Custom fields</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                    {cvLookup.fields.map((f) => {
                      const v = cvLookup.get(id, f.id);
                      const fallback = v == null ? rawAttrs?.[f.slug] : v;
                      return (
                        <FieldRow key={f.id} label={f.name}>
                          <CustomFieldCell field={f} entityId={id} value={fallback} />
                        </FieldRow>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
            {extraAttrs.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Other attributes</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    {extraAttrs.map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-0.5">{k}</div>
                        <div className="text-sm break-words">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
              <CardContent>
                {actLoading ? (
                  <Skeleton className="h-20" />
                ) : activities.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity logged yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {activities.map((a) => {
                      const snippet = activitySnippet(a);
                      return (
                        <li key={a.id} className="rounded border px-3 py-2">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                              {formatDistanceToNowStrict(new Date(a.created_at), { addSuffix: true })}
                            </span>
                            <span className="text-sm text-foreground/85">{activityLabel(a)}</span>
                          </div>
                          {snippet && (
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{snippet}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notes" className="mt-4">
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent>
                <NotesPanel entityType="person" entityId={id} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="meetings" className="mt-4">
            <Card>
              <CardHeader><CardTitle>Meetings</CardTitle></CardHeader>
              <CardContent>
                {meetings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No meetings yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {meetings.map((m) => (
                      <li key={m.id} className="rounded border px-3 py-2 flex items-center gap-3">
                        <span className="font-mono text-[11px] text-muted-foreground w-32 shrink-0">
                          {format(new Date(m.starts_at), 'MMM d, h:mm a')}
                        </span>
                        <span className="text-sm flex-1 truncate">{m.title}</span>
                        {m.location && (
                          <span className="text-xs text-muted-foreground truncate">{m.location}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="attachments" className="mt-4">
            <Card>
              <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
              <CardContent>
                <AttachmentsPanel entityType="person" entityId={id} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function FieldRow({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${full ? 'sm:col-span-2' : ''}`}>
      <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
