import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Plus, Loader2 } from 'lucide-react';
import { useCreateCompany } from '@/hooks/useCompanies';

function parseCompanyInput(raw: string): { name: string; domain: string | null } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const looksLikeDomain = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(trimmed);
  if (!looksLikeDomain) {
    return { name: trimmed, domain: null };
  }
  const host = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
  const label = host.split('.')[0];
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return { name, domain: host };
}

export function NewCompanyDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mut = useCreateCompany();

  const parsed = useMemo(() => parseCompanyInput(value), [value]);

  async function commit() {
    if (!parsed || submitting) return;
    setSubmitting(true);
    try {
      await mut.mutateAsync({ name: parsed.name, domain: parsed.domain });
      toast.success('Company added');
      setValue('');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add company');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setValue(''); }}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" />Add Company</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Company</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Domain or name</label>
          <Input
            placeholder="apple.com or Apple"
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
