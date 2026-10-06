import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEditMode } from '@/lib/editMode';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EntityAvatar } from '@/components/EntityAvatar';
import { InlineEditCell } from '@/components/InlineEditCell';
import { EnrichButton } from '@/components/EnrichButton';
import { NotesPanel } from '@/components/NotesPanel';
import { MeetingsPanel } from '@/components/MeetingsPanel';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import { useCompany } from '@/hooks/useCompany';
import { usePeopleByCompany } from '@/hooks/usePeople';
import { useDeals } from '@/hooks/useDeals';
import { useUpdateCompany } from '@/hooks/useCompanies';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { getEntity } from '@/lib/substrate';
import type { Company } from '@/lib/types';

type EditableCompanyField =
  | 'name' | 'domain' | 'industry' | 'location' | 'description'
  | 'linkedin_url' | 'employee_count';

const KNOWN_COMPANY_ATTR_KEYS = new Set([
  'name', 'domain', 'logo_object_id', 'industry', 'employee_count', 'location',
  'description', 'linkedin_url', 'enrichment_status', 'enriched_at',
  'ai_summary', 'ai_summary_at', 'custom_fields', 'deleted_at',
]);

function fullName(first?: string | null, last?: string | null): string {
  return `${first ?? ''} ${last ?? ''}`.trim() || 'Unnamed';
}

function stageBadgeVariant(stage: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (stage === 'won') return 'default';
  if (stage === 'lost') return 'destructive';
  return 'secondary';
}

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editModePref] = useEditMode();
  const [toggleEditing, setToggleEditing] = useState(false);
  // In hover mode every field is always live-editable. In toggle mode the user
  // must click the top "Edit" button first, so we disable InlineEditCell until
  // toggleEditing is true.
  const fieldsLocked = editModePref === 'toggle' && !toggleEditing;
  const { data: company, isLoading } = useCompany(id || '');
  const { data: people } = usePeopleByCompany(id || '');
  const { data: allDeals } = useDeals();
  const updateMut = useUpdateCompany();
  const cvLookup = useCustomValueLookup('companies');

  const deals = useMemo(() => {
    if (!allDeals || !id) return [];
    return allDeals.filter((d) => d.company_id === id);
  }, [allDeals, id]);

  const { data: rawAttrs } = useQuery({
    queryKey: ['company_raw_attrs', id],
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
      if (KNOWN_COMPANY_ATTR_KEYS.has(k)) return false;
      if (cfSlugs.has(k)) return false;
      if (v == null) return false;
      return true;
    });
  }, [rawAttrs, cfSlugs]);

  async function saveField(field: EditableCompanyField, value: string) {
    if (!company?.id) return;
    try {
      let patch: Partial<Company>;
      if (field === 'employee_count') {
        const n = value === '' ? null : Number(value);
        if (n !== null && Number.isNaN(n)) {
          toast.error('Employee count must be a number');
          throw new Error('nan');
        }
        patch = { employee_count: n } as Partial<Company>;
      } else {
        patch = { [field]: value === '' ? null : value } as Partial<Company>;
      }
      await updateMut.mutateAsync({ id: company.id, patch });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  }

  if (!id) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Company not found</h1>
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

  if (!company || !company.id) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Company not found</h1>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="flex items-start gap-4">
          <EntityAvatar objectId={company.logo_object_id} fallback={company.name} className="h-16 w-16" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="text-3xl font-semibold flex-1 min-w-0">
                <InlineEditCell
                  value={company.name}
                  placeholder="Name"
                  disabled={fieldsLocked}
                  onSave={(v) => saveField('name', v)}
                  className="text-3xl font-semibold"
                />
              </div>
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
              <EnrichButton kind="company" entityId={company.id} />
            </div>
            <div className="mt-2 grid max-w-2xl grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <FieldRow label="Domain">
                <InlineEditCell value={company.domain} placeholder="—" type="url" disabled={fieldsLocked} onSave={(v) => saveField('domain', v)} />
              </FieldRow>
              <FieldRow label="Industry">
                <InlineEditCell value={company.industry} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('industry', v)} />
              </FieldRow>
              <FieldRow label="Location">
                <InlineEditCell value={company.location} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('location', v)} />
              </FieldRow>
              <FieldRow label="Employees">
                <InlineEditCell
                  value={company.employee_count == null ? null : String(company.employee_count)}
                  placeholder="—"
                  disabled={fieldsLocked}
                  onSave={(v) => saveField('employee_count', v)}
                />
              </FieldRow>
              <FieldRow label="LinkedIn" full>
                <InlineEditCell value={company.linkedin_url} placeholder="—" type="url" disabled={fieldsLocked} onSave={(v) => saveField('linkedin_url', v)} />
              </FieldRow>
              <FieldRow label="Description" full>
                <InlineEditCell value={company.description} placeholder="—" disabled={fieldsLocked} onSave={(v) => saveField('description', v)} />
              </FieldRow>
              {company.enrichment_status && (
                <FieldRow label="Enrichment">
                  <span className="text-sm">
                    {company.enrichment_status}
                    {company.enriched_at && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        · {formatDistanceToNowStrict(new Date(company.enriched_at), { addSuffix: true })}
                      </span>
                    )}
                  </span>
                </FieldRow>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="space-y-6">
          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="deals">Deals</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
              <TabsTrigger value="meetings">Meetings</TabsTrigger>
              <TabsTrigger value="attachments">Attachments</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4 space-y-4">
              {company.ai_summary && (
                <Card>
                  <CardHeader><CardTitle>AI summary</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{company.ai_summary}</p>
                    {company.ai_summary_at && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Generated {formatDistanceToNowStrict(new Date(company.ai_summary_at), { addSuffix: true })}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
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
                <CardHeader><CardTitle>People</CardTitle></CardHeader>
                <CardContent>
                  {!people || people.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-8 text-center">
                      <p className="text-sm text-muted-foreground">No people at this company yet</p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12" />
                          <TableHead>Name</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead>Title</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {people.map((p) => (
                          <TableRow
                            key={p.id}
                            className="cursor-pointer"
                            onClick={() => navigate(`/people/${p.id}`)}
                          >
                            <TableCell>
                              <EntityAvatar objectId={p.avatar_object_id} fallback={fullName(p.first_name, p.last_name)} />
                            </TableCell>
                            <TableCell className="font-medium">{fullName(p.first_name, p.last_name)}</TableCell>
                            <TableCell className="text-sm">{p.email || '—'}</TableCell>
                            <TableCell className="text-sm">{p.title || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="deals" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Deals</CardTitle></CardHeader>
                <CardContent>
                  {deals.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-8 text-center">
                      <p className="text-sm text-muted-foreground">No deals for this company yet</p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Deal</TableHead>
                          <TableHead>Stage</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deals.map((d) => (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">{d.name}</TableCell>
                            <TableCell>
                              <Badge variant={stageBadgeVariant(d.stage)}>{d.stage}</Badge>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {d.amount_cents ? `${d.currency} ${(d.amount_cents / 100).toLocaleString()}` : '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="notes" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
                <CardContent>
                  <NotesPanel entityType="company" entityId={id} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="meetings" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Meetings</CardTitle></CardHeader>
                <CardContent>
                  <MeetingsPanel companyId={id} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="attachments" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
                <CardContent>
                  <AttachmentsPanel entityType="company" entityId={id} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
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
