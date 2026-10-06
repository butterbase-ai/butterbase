import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Loader2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { Filter, SortSpec } from '@/lib/filterDsl';
import type { CustomField, ObjectTypeSlug } from '@/lib/types';

interface Props {
  objectType: ObjectTypeSlug;
  customFields: CustomField[];
  onApply: (input: { filters: Filter[]; sort: SortSpec | null; suggested_name: string }) => void;
}

export function AISearchButton({ objectType, customFields, onApply }: Props) {
  const ws = useCurrentWorkspaceId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      const { data, error } = await bb.functions.invoke('ai-suggest-filters', {
        body: {
          object_type: objectType,
          prompt: prompt.trim(),
          workspace_id: ws,
          custom_fields: customFields.map((c) => ({ id: c.id, slug: c.slug, name: c.name, kind: c.kind })),
        },
      });
      if (error) throw error;
      const res = data as { filters: Filter[]; sort: SortSpec | null; suggested_name: string };
      onApply({ filters: res.filters, sort: res.sort, suggested_name: res.suggested_name });
      setOpen(false); setPrompt('');
      toast.success(`Applied ${res.filters.length} filter${res.filters.length === 1 ? '' : 's'}`);
    } catch (e: any) {
      toast.error(e?.message ?? 'AI search failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12.5px] border-emerald-300/60 text-emerald-700 hover:text-emerald-700 hover:border-emerald-400">
          <Sparkles className="h-3.5 w-3.5" />
          AI Search
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px]">
        <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex gap-2">
          <Input
            autoFocus
            placeholder={`Filter ${objectType} in plain English…`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="flex-1 h-9"
          />
          <Button type="submit" size="sm" disabled={loading || !prompt.trim()} className="h-9 px-3 gap-1.5 bg-foreground text-background hover:bg-foreground/85">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </Button>
        </form>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Translates your prompt into filter chips you can edit or save as a view.
        </p>
      </PopoverContent>
    </Popover>
  );
}
