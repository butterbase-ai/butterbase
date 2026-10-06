// frontend/src/components/AddPeopleToListDialog.tsx
//
// Add already-existing CRM people (substrate person entity ids) to a
// campaign_list — either an existing one or a fresh one. Complements
// AddToListDialog, which is Lead-Finder-specific (uses the lead-search
// KV cache to materialise brand-new people).
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { bb, bbInvoke } from '@/lib/butterbase';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { qk } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { Person } from '@/lib/types';

interface LeadListSummary {
  id: string;
  name: string;
  member_count: number;
}

type Target = 'existing' | 'new';

interface Props {
  open: boolean;
  onClose: () => void;
  people: Person[]; // must be the exact people being added (used for vars snapshot)
}

export function AddPeopleToListDialog({ open, onClose, people }: Props) {
  const workspaceId = useCurrentWorkspaceId();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target>('new');
  const [listName, setListName] = useState('');
  const [existingListId, setExistingListId] = useState<string>('');
  const [lists, setLists] = useState<LeadListSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    bb.functions
      .invoke('list-lead-lists', { body: { workspace_id: workspaceId } })
      .then((res) => {
        if (res.error) throw res.error;
        const l = ((res.data as any)?.lists ?? []) as LeadListSummary[];
        setLists(l);
        // If they have lists, default to add-to-existing (matches user intent).
        setTarget(l.length > 0 ? 'existing' : 'new');
      })
      .catch((e: any) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [open, workspaceId]);

  function valid(): boolean {
    if (people.length === 0) return false;
    if (target === 'existing') return existingListId !== '';
    return listName.trim() !== '';
  }

  async function save() {
    if (!valid()) {
      setError(target === 'existing' ? 'Pick a list.' : 'Enter a list name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const members = people.map((p) => ({
        id: p.id,
        email: p.email ?? null,
        vars: {
          first_name: p.first_name ?? null,
          last_name: p.last_name ?? null,
          title: p.title ?? null,
        },
      }));

      const body: Record<string, unknown> = {
        workspace_id: workspaceId,
        members,
      };
      if (target === 'existing') {
        body.list_id = existingListId;
      } else {
        body.name = listName.trim();
        body.entity_type = 'people';
        body.source = 'manual';
      }

      const { data, error: e } = await bbInvoke<{ list: any; member_count: number; requested_count: number }>(
        'create-campaign-list',
        body,
      );
      if (e) throw e;
      if (!data) throw new Error('create-campaign-list returned no data');

      qc.invalidateQueries({ queryKey: qk.campaignLists(workspaceId) });

      const added = data.member_count ?? 0;
      const requested = data.requested_count ?? members.length;
      const dupes = Math.max(0, requested - added);
      const listName2 = data.list?.name ?? 'list';
      const description = dupes > 0 ? `${dupes} skipped (already in list)` : undefined;

      if (added === 0) {
        toast.error('No one added', { description: 'Everyone selected is already in the list.' });
      } else {
        toast.success(`Added ${added} to "${listName2}"`, { description });
      }
      onClose();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setError(msg);
      toast.error('Failed to add to list', { description: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Add {people.length} {people.length === 1 ? 'person' : 'people'} to a list
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <label className="flex items-start gap-2 cursor-pointer rounded-md border p-2 hover:bg-muted/30">
            <input
              type="radio"
              name="p2l-target"
              value="existing"
              checked={target === 'existing'}
              onChange={() => setTarget('existing')}
              className="mt-1"
              disabled={saving || lists.length === 0}
            />
            <div className="flex-1">
              <div className="text-sm font-medium">Add to existing list</div>
              <select
                value={existingListId}
                onChange={(e) => setExistingListId(e.target.value)}
                onFocus={() => setTarget('existing')}
                disabled={saving || lists.length === 0}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
              >
                <option value="">{loading ? 'Loading…' : lists.length === 0 ? 'No lists yet' : 'Pick a list…'}</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.member_count})
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer rounded-md border p-2 hover:bg-muted/30">
            <input
              type="radio"
              name="p2l-target"
              value="new"
              checked={target === 'new'}
              onChange={() => setTarget('new')}
              className="mt-1"
              disabled={saving}
            />
            <div className="flex-1">
              <div className="text-sm font-medium">Create new list</div>
              <Input
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                onFocus={() => setTarget('new')}
                placeholder="e.g. Q3 warm leads"
                className="mt-1"
                disabled={saving}
              />
            </div>
          </label>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !valid()}>
            {saving ? 'Adding…' : 'Add to list'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
