import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { formatDistanceToNowStrict } from 'date-fns';
import { ListPlus, Trash2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/EntityAvatar';
import { NewPersonDialog } from '@/components/NewPersonDialog';
import { InlineEditCell } from '@/components/InlineEditCell';
import { ObjectToolbar } from '@/components/toolbar/ObjectToolbar';
import { useObjectView } from '@/components/toolbar/useObjectView';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import { AddPeopleToListDialog } from '@/components/AddPeopleToListDialog';
import { usePeople, useUpdatePerson, useDeletePerson } from '@/hooks/usePeople';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { rowMatches, parseCustomFieldRef } from '@/lib/filterDsl';
import type { Person } from '@/lib/types';

type EditableField = 'first_name' | 'last_name' | 'email' | 'phone' | 'title' | 'linkedin_url';

function fullName(first?: string | null, last?: string | null): string {
  return `${first ?? ''} ${last ?? ''}`.trim() || 'Unnamed';
}

export default function PeopleList() {
  const { data: people, isLoading } = usePeople();
  const updateMut = useUpdatePerson();
  const deleteMut = useDeletePerson();
  const navigate = useNavigate();
  const v = useObjectView('people');
  const cvLookup = useCustomValueLookup('people');
  const [showRoleAccounts, setShowRoleAccounts] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addToListOpen, setAddToListOpen] = useState(false);

  const roleAccountCount = useMemo(
    () => (people ?? []).filter((p) => p.is_role_account).length,
    [people],
  );

  const rows = useMemo(() => {
    const list = (people ?? []).filter((p) => showRoleAccounts || !p.is_role_account);
    const filtered = v.filters.length === 0 ? list : list.filter((p) =>
      v.filters.every((f) => rowMatches(p, f, (row, ref) => {
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
  }, [people, v.filters, v.sort, cvLookup, showRoleAccounts]);

  const visibleBuilt = v.visibleFields.filter((s) => !parseCustomFieldRef(s));
  const visibleCustom = v.visibleFields.map(parseCustomFieldRef).filter((x): x is string => !!x);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && rows.some((r) => selected.has(r.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }

  const selectedPeople = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  async function saveField(id: string, field: EditableField, value: string) {
    try {
      const patch: Partial<Person> = { [field]: value === '' ? null : value } as Partial<Person>;
      await updateMut.mutateAsync({ id, patch });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  }

  async function deleteSelected() {
    if (selectedPeople.length === 0) return;
    const label = selectedPeople.length === 1
      ? fullName(selectedPeople[0].first_name, selectedPeople[0].last_name)
      : `${selectedPeople.length} people`;
    if (!window.confirm(`Delete ${label}? This can't be undone from the UI.`)) return;

    const ids = selectedPeople.map((p) => p.id);
    const results = await Promise.allSettled(ids.map((id) => deleteMut.mutateAsync(id)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    const ok = results.length - failed;
    if (failed === 0) {
      toast.success(`Deleted ${ok} ${ok === 1 ? 'person' : 'people'}`);
    } else if (ok === 0) {
      toast.error('Delete failed');
    } else {
      toast.warning(`Deleted ${ok}, ${failed} failed`);
    }
    setSelected(new Set());
  }

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 02 · Humans</p>
          <h1 className="page-title">
            People <em>worth knowing</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            The faces behind the accounts — every contact, every conversation, in one place.
          </p>
        </div>
        <div className="flex items-center gap-3 self-end">
          {roleAccountCount > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Switch checked={showRoleAccounts} onCheckedChange={setShowRoleAccounts} />
              <span>Show role mailboxes ({roleAccountCount})</span>
            </label>
          )}
          <NewPersonDialog />
        </div>
      </div>

      <ObjectToolbar objectType="people" filteredIds={rows.map((r) => r.id)} />

      {selected.size > 0 && (
        <div className="flex items-center justify-between border-b bg-butter/[0.06] px-8 py-2 text-sm">
          <div>
            <span className="font-medium">{selected.size}</span> selected
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="ml-3 text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAddToListOpen(true)}>
              <ListPlus className="h-3.5 w-3.5 mr-1.5" />
              Add to list…
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={deleteSelected}
              disabled={deleteMut.isPending}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto px-8 py-6">
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <h3 className="font-medium">{(people ?? []).length === 0 ? 'No people yet' : 'No matches'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {(people ?? []).length === 0 ? 'Add your first contact to get started.' : 'Loosen filters or clear them to see everyone.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                  />
                </TableHead>
                <TableHead className="w-12" />
                {visibleBuilt.map((slug) => (
                  <TableHead key={slug}>{labelFor(slug)}</TableHead>
                ))}
                {visibleCustom.map((id) => {
                  const f = cvLookup.fields.find((x) => x.id === id);
                  return <TableHead key={id}>{f?.name ?? '—'}</TableHead>;
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const name = fullName(p.first_name, p.last_name);
                const isSelected = selected.has(p.id);
                return (
                  <TableRow
                    key={p.id}
                    onClick={() => navigate(`/people/${p.id}`)}
                    className={`cursor-pointer hover:bg-butter/[0.04] ${isSelected ? 'bg-butter/[0.06]' : ''}`}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={isSelected}
                        onChange={() => toggleOne(p.id)}
                      />
                    </TableCell>
                    <TableCell><EntityAvatar objectId={p.avatar_object_id} fallback={name} /></TableCell>
                    {visibleBuilt.map((slug) => (
                      <TableCell key={slug} onClick={(e) => e.stopPropagation()} className="text-sm">
                        {renderBuiltin(p, slug, name, saveField)}
                      </TableCell>
                    ))}
                    {visibleCustom.map((id) => (
                      <TableCell key={id} onClick={(e) => e.stopPropagation()} className="text-sm">
                        <CustomFieldCell
                          field={cvLookup.fields.find((x) => x.id === id)}
                          entityId={p.id}
                          value={cvLookup.get(p.id, id)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <AddPeopleToListDialog
        open={addToListOpen}
        onClose={() => {
          setAddToListOpen(false);
          setSelected(new Set());
        }}
        people={selectedPeople}
      />
    </div>
  );
}

function labelFor(slug: string): string {
  switch (slug) {
    case 'first_name': return 'Name';
    case 'last_name': return 'Last name';
    case 'email': return 'Email';
    case 'title': return 'Title';
    case 'phone': return 'Phone';
    case 'linkedin_url': return 'LinkedIn';
    case 'created_at': return 'Created';
    case 'updated_at': return 'Updated';
    default: return slug;
  }
}

function renderBuiltin(
  p: Person,
  slug: string,
  name: string,
  save: (id: string, field: EditableField, v: string) => Promise<void>,
) {
  if (slug === 'first_name') {
    return (
      <div className="flex items-center gap-1">
        <InlineEditCell
          value={p.first_name}
          placeholder={name === 'Unnamed' ? 'First' : '—'}
          onSave={(v) => save(p.id, 'first_name', v)}
          className="font-medium"
        />
        <InlineEditCell
          value={p.last_name}
          placeholder="Last"
          onSave={(v) => save(p.id, 'last_name', v)}
          className="font-medium"
        />
        {p.is_role_account && (
          <Badge variant="outline" className="ml-1 text-[10px] font-normal text-muted-foreground">
            role
          </Badge>
        )}
      </div>
    );
  }
  if (slug === 'last_name') {
    return <InlineEditCell value={p.last_name} placeholder="—" onSave={(v) => save(p.id, 'last_name', v)} />;
  }
  if (slug === 'email') {
    const status = p.email_status;
    if (!p.email && status === 'pending') {
      return <span className="text-muted-foreground italic text-xs">pending…</span>;
    }
    if (!p.email && status === 'failed') {
      return <span className="text-muted-foreground italic text-xs" title="Email lookup failed">unavailable</span>;
    }
    return <InlineEditCell value={p.email} placeholder="—" onSave={(v) => save(p.id, 'email', v)} />;
  }
  if (slug === 'phone') {
    return <InlineEditCell value={p.phone} placeholder="—" onSave={(v) => save(p.id, 'phone', v)} />;
  }
  if (slug === 'title') {
    return <InlineEditCell value={p.title} placeholder="—" onSave={(v) => save(p.id, 'title', v)} />;
  }
  if (slug === 'linkedin_url') {
    return <InlineEditCell value={p.linkedin_url} placeholder="—" onSave={(v) => save(p.id, 'linkedin_url', v)} />;
  }
  if (slug === 'updated_at' || slug === 'created_at') {
    const val = (p as any)[slug];
    return <span className="text-muted-foreground">{val ? formatDistanceToNowStrict(new Date(val), { addSuffix: true }) : '—'}</span>;
  }
  return (p as any)[slug] ?? '—';
}
