import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Filter as FilterIcon, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type Filter, type FieldSpec, type FilterOp,
  opsForKind, OP_LABEL, formatFilterChip,
} from '@/lib/filterDsl';

interface Props {
  fields: FieldSpec[];
  filters: Filter[];
  onChange: (next: Filter[]) => void;
}

export function FilterPopover({ fields, filters, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draftField, setDraftField] = useState<string>('');
  const [draftOp, setDraftOp] = useState<FilterOp>('contains');
  const [draftValue, setDraftValue] = useState('');

  function addDraft() {
    const f = fields.find((x) => x.slug === draftField);
    if (!f) return;
    const needsValue = !['is_null', 'not_null'].includes(draftOp);
    const value = !needsValue
      ? undefined
      : draftOp === 'in'
        ? draftValue.split(',').map((s) => s.trim()).filter(Boolean)
        : draftOp === 'between'
          ? draftValue.split(',').map((s) => s.trim()).slice(0, 2)
          : f.kind === 'number'
            ? Number(draftValue)
            : draftValue;
    onChange([...filters, { field: draftField, op: draftOp, value }]);
    setDraftField(''); setDraftOp('contains'); setDraftValue('');
  }

  function remove(i: number) {
    onChange(filters.filter((_, idx) => idx !== i));
  }

  const draftSpec = fields.find((f) => f.slug === draftField);
  const draftOps = draftSpec ? opsForKind(draftSpec.kind) : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12.5px] font-normal">
          <FilterIcon className="h-3.5 w-3.5" />
          Filter
          {filters.length > 0 && (
            <span className="ml-0.5 rounded-full bg-butter/30 px-1.5 py-0.5 font-mono text-[10px] text-foreground">{filters.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[440px] p-3">
        {filters.length === 0 ? (
          <p className="mb-2 text-[12px] text-muted-foreground">No filters yet. Pick a field below to start.</p>
        ) : (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {filters.map((f, i) => (
              <span key={i} className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-[12px]',
              )}>
                <span>{formatFilterChip(f, fields)}</span>
                <button onClick={() => remove(i)} className="text-muted-foreground hover:text-coral">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[1fr_120px_auto] gap-2 items-center">
          <Select value={draftField} onValueChange={(v) => { setDraftField(v); const f = fields.find((x) => x.slug === v); if (f) setDraftOp(opsForKind(f.kind)[0]); }}>
            <SelectTrigger className="h-8 text-[12.5px]"><SelectValue placeholder="Field…" /></SelectTrigger>
            <SelectContent className="max-h-60">
              {fields.map((f) => <SelectItem key={f.slug} value={f.slug}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={draftOp} onValueChange={(v) => setDraftOp(v as FilterOp)} disabled={!draftSpec}>
            <SelectTrigger className="h-8 text-[12.5px]"><SelectValue /></SelectTrigger>
            <SelectContent>{draftOps.map((o) => <SelectItem key={o} value={o}>{OP_LABEL[o]}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={addDraft} disabled={!draftSpec} className="h-8 w-8 p-0 text-foreground">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {draftSpec && !['is_null', 'not_null'].includes(draftOp) && (
          <Input
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder={
              draftOp === 'in' ? 'comma-separated values' :
              draftOp === 'between' ? 'min, max' :
              draftSpec.kind === 'date' ? 'ISO date e.g. 2026-01-01' :
              'value'
            }
            className="mt-2 h-8 text-[12.5px]"
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
