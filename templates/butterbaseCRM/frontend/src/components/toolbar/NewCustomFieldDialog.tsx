import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useCreateCustomField } from '@/hooks/useCustomFields';
import type { CustomFieldKind, ObjectTypeSlug } from '@/lib/types';

const KINDS: { value: CustomFieldKind; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select', label: 'Single select' },
  { value: 'multiselect', label: 'Multi select' },
];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
}

interface Props { objectType: ObjectTypeSlug; children: ReactNode }

export function NewCustomFieldDialog({ objectType, children }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CustomFieldKind>('text');
  const [optionsText, setOptionsText] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const create = useCreateCustomField();

  useEffect(() => {
    bb.auth.getUser().then(({ data }: any) => setUserId(data?.id ?? null));
  }, []);

  async function submit() {
    if (!name.trim() || !userId) return;
    const slug = slugify(name);
    const config = (kind === 'select' || kind === 'multiselect')
      ? { options: optionsText.split(',').map((s) => s.trim()).filter(Boolean) }
      : null;
    try {
      await create.mutateAsync({
        object_type: objectType,
        name: name.trim(),
        slug,
        kind,
        config,
        position: 99,
        created_by: userId,
      });
      toast.success(`Added “${name.trim()}”`);
      setName(''); setOptionsText(''); setKind('text');
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to create field');
    }
  }

  const needsOptions = kind === 'select' || kind === 'multiselect';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="font-display tracking-tight">New custom field</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="eyebrow !text-[10px]">Name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead score" className="mt-1" />
          </div>
          <div>
            <Label className="eyebrow !text-[10px]">Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as CustomFieldKind)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {needsOptions && (
            <div>
              <Label className="eyebrow !text-[10px]">Options (comma-separated)</Label>
              <Input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="Hot, Warm, Cold" className="mt-1" />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={submit} disabled={!name.trim() || create.isPending} className="bg-foreground text-background hover:bg-foreground/85">
              Add field
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
