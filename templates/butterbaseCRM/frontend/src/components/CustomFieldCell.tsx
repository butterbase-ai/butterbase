import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUpsertCustomFieldValue } from '@/hooks/useCustomFields';
import type { CustomField } from '@/lib/types';

interface Props {
  field: CustomField | undefined;
  entityId: string;
  value: unknown;
}

export function CustomFieldCell({ field, entityId, value }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const upsert = useUpsertCustomFieldValue();

  useEffect(() => { setDraft(value == null ? '' : String(value)); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!field) return <span className="text-muted-foreground text-sm">—</span>;

  function commit(next: unknown) {
    upsert.mutate({ field: field!, entity_id: entityId, value: next });
    setEditing(false);
  }

  if (field.kind === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => commit(e.target.checked)}
        className="h-4 w-4 accent-butter"
      />
    );
  }

  if (field.kind === 'select') {
    const options = (field.config as any)?.options ?? [];
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <Select
          value={(value as string) ?? ''}
          onValueChange={(v) => commit(v === '' ? null : v)}
        >
          <SelectTrigger className="h-8 text-sm w-[160px]"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {options.map((o: string) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed === '') commit(null);
          else if (field.kind === 'number') {
            const n = Number(trimmed);
            commit(Number.isFinite(n) ? n : null);
          } else commit(trimmed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setDraft(value == null ? '' : String(value)); setEditing(false); }
        }}
        className="h-8 text-sm"
        type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setDraft(value == null ? '' : String(value)); setEditing(true); }}
      className={cn(
        'group flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent/40',
      )}
    >
      <span className={cn('truncate', (value == null || value === '') && 'text-muted-foreground')}>
        {value == null || value === '' ? '—' : String(value)}
      </span>
      <Pencil className="invisible h-3 w-3 text-muted-foreground group-hover:visible" />
    </button>
  );
}
