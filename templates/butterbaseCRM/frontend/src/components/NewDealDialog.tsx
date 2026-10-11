import { uiText, useUiLocale } from "../i18n";
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Plus, Loader2 } from 'lucide-react';
import { useCreateDeal } from '@/hooks/useDeals';
import { bb } from '@/lib/butterbase';

export function NewDealDialog() {
  useUiLocale();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mut = useCreateDeal();

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const { data: user } = await bb.auth.getUser();
      if (!user?.id) throw new Error(uiText('No current user'));
      await mut.mutateAsync({
        name: trimmed,
        company_id: null,
        stage: 'lead',
        amount_cents: null,
        close_date: null,
        owner_user_id: user.id,
      });
      toast.success(uiText('Deal added'));
      setName('');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : uiText('Failed to add deal'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setName(''); }}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" />{uiText("Add Deal")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{uiText("Add Deal")}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">{uiText("Name")}</label>
          <Input
            placeholder={uiText("Acme expansion Q3")}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          />
          {name.trim() && (
            <button
              type="button"
              onClick={commit}
              disabled={submitting}
              className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span>{uiText("Add ")}<span className="font-medium">"{name.trim()}"</span></span>
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
