import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Plus, Loader2 } from 'lucide-react';
import { useCreatePerson } from '@/hooks/usePeople';

interface Parsed {
  email: string | null;
  first_name: string;
  last_name: string | null;
}

function parsePersonInput(raw: string): Parsed | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  if (isEmail) {
    const local = trimmed.split('@')[0];
    const tokens = local.split(/[._-]+/).filter(Boolean);
    const first = tokens[0] ?? local;
    const last = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
    return {
      email: trimmed.toLowerCase(),
      first_name: first.charAt(0).toUpperCase() + first.slice(1),
      last_name: last ? last.charAt(0).toUpperCase() + last.slice(1) : null,
    };
  }
  const parts = trimmed.split(/\s+/);
  return {
    email: null,
    first_name: parts[0],
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

interface Props { defaultCompanyId?: string | null }

export function NewPersonDialog({ defaultCompanyId }: Props = {}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mut = useCreatePerson();
  const parsed = useMemo(() => parsePersonInput(value), [value]);

  async function commit() {
    if (!parsed || submitting) return;
    setSubmitting(true);
    try {
      await mut.mutateAsync({
        company_id: defaultCompanyId ?? null,
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        email: parsed.email,
        phone: null,
        title: null,
        linkedin_url: null,
      });
      toast.success('Person added');
      setValue('');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add person');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setValue(''); }}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" />Add Person</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Person</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Email or name</label>
          <Input
            placeholder="jane@acme.com or Jane Doe"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          />
          {parsed && (
            <button
              type="button"
              onClick={commit}
              disabled={submitting}
              className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span>Add <span className="font-medium">"{value.trim()}"</span></span>
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
