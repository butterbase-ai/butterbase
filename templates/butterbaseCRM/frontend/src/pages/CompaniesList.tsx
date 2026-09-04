import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { formatDistanceToNowStrict } from 'date-fns';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ObjectToolbar } from '@/components/toolbar/ObjectToolbar';
import { useObjectView } from '@/components/toolbar/useObjectView';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { rowMatches, parseCustomFieldRef } from '@/lib/filterDsl';

function labelFor(slug: string): string {
  switch (slug) {
    case 'name': return 'Company';
    case 'domain': return 'Domain';
    case 'industry': return 'Industry';
    case 'location': return 'Location';
    case 'employee_count': return 'Employees';
    case 'description': return 'Description';
    case 'linkedin_url': return 'LinkedIn';
    case 'created_at': return 'Created';
    case 'updated_at': return 'Updated';
    default: return slug;
  }
}

function renderBuiltin(c: Company, slug: string, save: (id: string, field: EditableField, v: string) => Promise<void>) {
  if (slug === 'name') {
    return <InlineEditCell value={c.name} onSave={(v) => save(c.id, 'name', v)} className="font-medium" />;
  }
  if (slug === 'domain') {
    return <InlineEditCell value={c.domain} placeholder="—" onSave={(v) => save(c.id, 'domain', v)} />;
  }
  if (slug === 'industry') {
    return <InlineEditCell value={c.industry} placeholder="—" onSave={(v) => save(c.id, 'industry', v)} />;
  }
  if (slug === 'location') {
    return <InlineEditCell value={c.location} placeholder="—" onSave={(v) => save(c.id, 'location', v)} />;
  }
  if (slug === 'employee_count') {
    return (
      <InlineEditCell
        value={c.employee_count == null ? null : String(c.employee_count)}
        placeholder="—"
        onSave={(v) => save(c.id, 'employee_count', v)}
      />
    );
  }
  if (slug === 'description') {
    return <InlineEditCell value={c.description} placeholder="—" onSave={(v) => save(c.id, 'description', v)} />;
  }
  if (slug === 'linkedin_url') {
    return <InlineEditCell value={c.linkedin_url} placeholder="—" onSave={(v) => save(c.id, 'linkedin_url', v)} />;
  }
  if (slug === 'updated_at' || slug === 'created_at') {
    const v = (c as any)[slug];
    return <span className="text-sm text-muted-foreground">{v ? formatDistanceToNowStrict(new Date(v), { addSuffix: true }) : '—'}</span>;
  }
  const v = (c as any)[slug];
  return <span className="text-sm">{v == null || v === '' ? '—' : String(v)}</span>;
}
import { EntityAvatar } from '@/components/EntityAvatar';
import { NewCompanyDialog } from '@/components/NewCompanyDialog';
import { InlineEditCell } from '@/components/InlineEditCell';
import { useCompanies, useUpdateCompany } from '@/hooks/useCompanies';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import type { Company } from '@/lib/types';

type EditableField = 'name' | 'domain' | 'description' | 'linkedin_url' | 'industry' | 'location' | 'employee_count';

export default function CompaniesList() {
  const { data: companies, isLoading } = useCompanies();
  const updateMut = useUpdateCompany();
  const navigate = useNavigate();
  const v = useObjectView('companies');
  const cvLookup = useCustomValueLookup('companies');

  const rows = useMemo(() => {
    const list = companies ?? [];
    const filtered = v.filters.length === 0 ? list : list.filter((c) =>
      v.filters.every((f) => rowMatches(c, f, (row, ref) => {
        const id = parseCustomFieldRef(ref);
        return id ? cvLookup.get(row.id, id) : null;
      })),
    );
    if (!v.sort) return filtered;
    const dir = v.sort.direction === 'asc' ? 1 : -1;
    const field = v.sort.field;
    return [...filtered].sort((a: any, b: any) => {
      const av = a?.[field] ?? ''; const bv = b?.[field] ?? '';
      return av > bv ? dir : av < bv ? -dir : 0;
    });
  }, [companies, v.filters, v.sort, cvLookup]);

  async function saveField(id: string, field: EditableField, value: string) {
    try {
      let next: string | number | null = value || null;
      if (field === 'employee_count') {
        if (value === '') {
          next = null;
        } else {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            toast.error('Employees must be a non-negative number');
            throw new Error('invalid employee_count');
          }
          next = Math.trunc(n);
        }
      }
      const patch: Partial<Company> = { [field]: next } as Partial<Company>;
      await updateMut.mutateAsync({ id, patch });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 01 · Accounts</p>
          <h1 className="page-title">
            Companies <em>&amp; counterparts</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Every organisation you’re building a relationship with — sorted, searchable, alive.
          </p>
        </div>
        <div className="flex items-center gap-3 self-end">
          <NewCompanyDialog />
        </div>
      </div>

      <ObjectToolbar objectType="companies" filteredIds={rows.map((r) => r.id)} />

      <div className="flex-1 overflow-auto px-8 py-6">
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <h3 className="font-medium">{(companies ?? []).length === 0 ? 'No companies yet' : 'No matches'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {(companies ?? []).length === 0 ? 'Add your first company to get started.' : 'Loosen filters or clear them.'}
            </p>
          </div>
        ) : (
          (() => {
            const visibleBuilt = v.visibleFields.filter((s) => !parseCustomFieldRef(s));
            const visibleCustom = v.visibleFields.map(parseCustomFieldRef).filter((x): x is string => !!x);
            return (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12" />
                    {visibleBuilt.map((slug) => <TableHead key={slug}>{labelFor(slug)}</TableHead>)}
                    {visibleCustom.map((id) => {
                      const f = cvLookup.fields.find((x) => x.id === id);
                      return <TableHead key={id}>{f?.name ?? '—'}</TableHead>;
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/companies/${c.id}`)}>
                      <TableCell><EntityAvatar objectId={c.logo_object_id} fallback={c.name} /></TableCell>
                      {visibleBuilt.map((slug) => (
                        <TableCell key={slug} onClick={(e) => e.stopPropagation()} className={slug === 'description' ? 'max-w-md' : ''}>
                          {renderBuiltin(c, slug, saveField)}
                        </TableCell>
                      ))}
                      {visibleCustom.map((id) => (
                        <TableCell key={id} onClick={(e) => e.stopPropagation()} className="text-sm">
                          <CustomFieldCell
                            field={cvLookup.fields.find((x) => x.id === id)}
                            entityId={c.id}
                            value={cvLookup.get(c.id, id)}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          })()
        )}
      </div>
    </div>
  );
}
