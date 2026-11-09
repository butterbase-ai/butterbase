import { uiText, useUiLocale } from "../i18n";
// frontend/src/components/AddToListDialog.tsx
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface CostPreview {
  credits: number;
  usd_estimate: number;
  reveal_emails: boolean;
}

interface LeadListSummary {
  id: string;
  name: string;
  member_count: number;
}

type Target = 'all_people' | 'existing' | 'new';

interface Props {
  open: boolean;
  onClose: () => void;
  queryHash: string;
  selectedIds: string[];
  onSaved: (info: { saved_count: number; list_id: string | null }) => void;
}

export function AddToListDialog({ open, onClose, queryHash, selectedIds, onSaved }: Props) {
  useUiLocale();
  const workspaceId = useCurrentWorkspaceId();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target>('all_people');
  const [listName, setListName] = useState('');
  const [existingListId, setExistingListId] = useState<string>('');
  const [existingLists, setExistingLists] = useState<LeadListSummary[]>([]);
  const [revealCost, setRevealCost] = useState<CostPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load cost + existing lists when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setRevealCost(null);
    setExistingLists([]);
    setLoading(true);

    Promise.all([
      bb.functions.invoke('lead-cost-preview', { body: { result_ids: selectedIds, reveal_emails: true } }),
      bb.functions.invoke('list-lead-lists', { body: { workspace_id: workspaceId } }),
    ])
      .then(([costRes, listsRes]) => {
        if (costRes.error) throw costRes.error;
        setRevealCost(costRes.data as CostPreview);
        if (!listsRes.error) {
          const lists = ((listsRes.data as any)?.lists ?? []) as LeadListSummary[];
          setExistingLists(lists);
        }
      })
      .catch((e: any) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [open, selectedIds]);

  function targetValid(): boolean {
    if (target === 'all_people') return true;
    if (target === 'existing') return existingListId !== '';
    if (target === 'new') return listName.trim() !== '';
    return false;
  }

  async function save(reveal: boolean) {
    if (!targetValid()) {
      setError(
        target === 'existing'
          ? uiText('Pick a list.')
          : target === 'new'
          ? uiText('Enter a list name.')
          : uiText('Pick a target.'),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        workspace_id: workspaceId,
        query_hash: queryHash,
        result_ids: selectedIds,
        reveal_emails: reveal,
        target,
      };
      if (target === 'existing') body.list_id = existingListId;
      if (target === 'new') body.new_list_name = listName.trim();

      const { data, error: e } = await bb.functions.invoke('lead-save', { body });
      if (e) throw e;
      const d = data as { saved_count: number; list_id: string | null; pending_email_count?: number };

      qc.invalidateQueries({ queryKey: qk.campaignLists(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.people(workspaceId) });

      const requested = selectedIds.length;
      const savedCount = d.saved_count ?? 0;
      const pending = d.pending_email_count ?? 0;
      const missed = Math.max(0, requested - savedCount);

      const parts: string[] = [`${savedCount} of ${requested} saved to People`];
      if (reveal && pending > 0) parts.push(`${pending} email${pending === 1 ? '' : 's'} pending`);
      if (missed > 0) parts.push(`${missed} skipped (duplicates)`);
      const description = parts.slice(1).join(' · ') || undefined;

      if (savedCount === 0) {
        toast.error(uiText('No leads saved'), { description: uiText('All picks were duplicates or already in the list.') });
      } else {
        toast.success(parts[0], { description });
      }

      onSaved(d);
      onClose();

      // If we queued any email lookups, fire off a few background resolves so the
      // user sees pending → verified happen on their People page within seconds.
      if (reveal && (d.pending_email_count ?? 0) > 0) {
        const delays = [2000, 5000, 10000, 20000]; // ms after save
        for (const ms of delays) {
          setTimeout(() => {
            bb.functions
              .invoke('resolve-pending-emails', { body: {} })
              .catch(() => undefined);
          }, ms);
        }
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setError(msg);
      toast.error(uiText('Failed to save leads'), { description: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{uiText("Add ")}{selectedIds.length} {selectedIds.length === 1 ? uiText('lead') : uiText('leads')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">{uiText("Where should these go?")}</label>

            <label className="flex items-start gap-2 cursor-pointer rounded-md border p-2 hover:bg-muted/30">
              <input
                type="radio"
                name="target"
                value="all_people"
                checked={target === 'all_people'}
                onChange={() => setTarget('all_people')}
                className="mt-1"
                disabled={saving}
              />
              <div>
                <div className="text-sm font-medium">{uiText("All people (no list)")}</div>
                <div className="text-xs text-muted-foreground">{uiText("Save into the CRM's People — no list grouping.")}</div>
              </div>
            </label>

            <label className="flex items-start gap-2 cursor-pointer rounded-md border p-2 hover:bg-muted/30">
              <input
                type="radio"
                name="target"
                value="existing"
                checked={target === 'existing'}
                onChange={() => setTarget('existing')}
                className="mt-1"
                disabled={saving || existingLists.length === 0}
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{uiText("Add to existing list")}</div>
                <select
                  value={existingListId}
                  onChange={(e) => setExistingListId(e.target.value)}
                  onFocus={() => setTarget('existing')}
                  disabled={saving || existingLists.length === 0}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
                >
                  <option value="">{existingLists.length === 0 ? uiText('No lists yet') : uiText('Pick a list…')}</option>
                  {existingLists.map((l) => (
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
                name="target"
                value="new"
                checked={target === 'new'}
                onChange={() => setTarget('new')}
                className="mt-1"
                disabled={saving}
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{uiText("Create new list")}</div>
                <Input
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                  onFocus={() => setTarget('new')}
                  placeholder={uiText("e.g. Q3 fintech VPs")}
                  className="mt-1"
                  disabled={saving}
                />
              </div>
            </label>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {loading && <div className="text-muted-foreground">{uiText("Calculating cost…")}</div>}
            {revealCost && (
              <>
                <div>
                  {uiText("Revealing emails will use ")}<span className="font-medium">{revealCost.credits} {uiText(" credits")}</span>
                  {' '}(≈ <span className="font-medium">${revealCost.usd_estimate.toFixed(2)}</span>)
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {uiText("Or add without revealing — leads are saved with empty email; you can reveal later.")}</div>
              </>
            )}
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{uiText("Cancel")}</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving || !targetValid()}>
            {uiText("Add without emails")}</Button>
          <Button onClick={() => save(true)} disabled={saving || !targetValid() || !revealCost}>
            {uiText("Confirm & reveal")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
