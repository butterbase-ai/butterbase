import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ListPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useCreateCampaignList, type CreateListMemberInput } from '@/hooks/useCampaigns';
import { listEntities } from '@/lib/substrate';

interface Props {
  entityType: 'people' | 'companies';
  count: number;
  /** Substrate entity ids (ent_…) to snapshot into the list. */
  memberIds: string[];
  /** When the source was an AI search, the original spec is persisted for audit. */
  spec?: Record<string, unknown>;
  onSaved?: () => void;
}

async function resolveMembers(
  entityType: 'people' | 'companies',
  memberIds: string[],
): Promise<CreateListMemberInput[]> {
  const substrateType = entityType === 'people' ? 'person' : 'company';
  const all = await listEntities(substrateType, { limit: 500 });
  const idSet = new Set(memberIds);
  const matched = all.filter((e) => idSet.has(e.id));
  return matched.map((e) => {
    const a = e.attrs ?? {};
    if (entityType === 'people') {
      return {
        id: e.id,
        email: (a.email as string | null | undefined) ?? e.primary_email ?? null,
        vars: {
          first_name: (a.first_name as string | null | undefined) ?? null,
          last_name: (a.last_name as string | null | undefined) ?? null,
          title: (a.title as string | null | undefined) ?? null,
          company_name: (a.company_name as string | null | undefined) ?? (a.company as string | null | undefined) ?? null,
        },
      };
    }
    return {
      id: e.id,
      email: null,
      vars: {
        company_name: e.display_name ?? (a.name as string | null | undefined) ?? null,
      },
    };
  });
}

export function SaveListFromSearchDialog({ entityType, count, memberIds, spec, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const mut = useCreateCampaignList();
  const navigate = useNavigate();

  async function save() {
    if (!name.trim()) return;
    try {
      const members = await resolveMembers(entityType, memberIds);
      const res = await mut.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        entity_type: entityType,
        source: spec ? 'ai_search' : 'manual',
        source_spec: spec,
        members,
      });
      toast.success(`Saved “${res.list.name}” — ${res.member_count} members`);
      setOpen(false);
      onSaved?.();
      navigate(`/campaigns?tab=lists`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to save list');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-[12.5px]"
          disabled={count === 0}
        >
          <ListPlus className="h-3.5 w-3.5" />
          Save as list
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-tight">Save audience list</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[12.5px] text-muted-foreground">
            Snapshots <strong>{count}</strong> {entityType} matching this filter as a reusable campaign audience.
          </p>
          <div>
            <Label className="eyebrow !text-[10px]">Name</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fintech founders in NYC"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="eyebrow !text-[10px]">Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this list is for"
              className="mt-1 min-h-[60px]"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={mut.isPending}>Cancel</Button>
            <Button onClick={save} disabled={!name.trim() || mut.isPending} className="bg-foreground text-background hover:bg-foreground/85 gap-2">
              {mut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save list
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
