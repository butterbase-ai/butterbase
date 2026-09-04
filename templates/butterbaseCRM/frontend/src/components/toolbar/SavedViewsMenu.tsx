import { useEffect, useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Star, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useSavedViews, useCreateSavedView, useDeleteSavedView } from '@/hooks/useSavedViews';
import type { Filter, SortSpec } from '@/lib/filterDsl';
import type { ObjectTypeSlug, SavedView } from '@/lib/types';

interface Props {
  objectType: ObjectTypeSlug;
  activeView: SavedView | null;
  filters: Filter[];
  sort: SortSpec | null;
  visibleFields: string[];
  onSelect: (view: SavedView | null) => void;
}

export function SavedViewsMenu({ objectType, activeView, filters, sort, visibleFields, onSelect }: Props) {
  const { data: views } = useSavedViews(objectType);
  const create = useCreateSavedView();
  const del = useDeleteSavedView();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    bb.auth.getUser().then(({ data }: any) => setUserId(data?.id ?? null));
  }, []);

  const label = activeView?.name ?? `All ${objectType}`;

  async function saveCurrent() {
    if (!name.trim() || !userId) return;
    try {
      const v = await create.mutateAsync({
        object_type: objectType,
        name: name.trim(),
        filters,
        sort,
        visible_fields: visibleFields,
        is_default: false,
        created_by: userId,
      });
      toast.success(`Saved view “${v.name}”`);
      setSaveOpen(false); setName('');
      onSelect(v);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to save');
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12.5px]">
            <Star className="h-3.5 w-3.5 text-butter" />
            {label}
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuItem onClick={() => onSelect(null)} className="text-[12.5px]">
            All {objectType}
          </DropdownMenuItem>
          {(views ?? []).map((v) => (
            <DropdownMenuItem key={v.id} className="text-[12.5px] flex items-center justify-between gap-2">
              <button onClick={() => onSelect(v)} className="flex-1 text-left truncate">{v.name}</button>
              <button
                className="text-muted-foreground hover:text-coral"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete view “${v.name}”?`)) return;
                  try { await del.mutateAsync(v.id); toast.success('View deleted'); if (activeView?.id === v.id) onSelect(null); }
                  catch (err: any) { toast.error(err?.message ?? 'Failed'); }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSaveOpen(true)} className="text-[12.5px] gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Save current as view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="font-display tracking-tight">Save view</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="eyebrow !text-[10px]">Name</Label>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Founders in fintech" className="mt-1" />
            </div>
            <p className="text-[12px] text-muted-foreground">
              Snapshots {filters.length} filter{filters.length === 1 ? '' : 's'}, {visibleFields.length} visible field{visibleFields.length === 1 ? '' : 's'}{sort ? `, sorted by ${sort.field}` : ''}.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button>
              <Button onClick={saveCurrent} disabled={!name.trim() || create.isPending} className="bg-foreground text-background hover:bg-foreground/85">Save view</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
