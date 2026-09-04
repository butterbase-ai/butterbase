import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { EyeOff, Eye, Plus } from 'lucide-react';
import type { FieldSpec } from '@/lib/filterDsl';
import { NewCustomFieldDialog } from './NewCustomFieldDialog';
import type { ObjectTypeSlug } from '@/lib/types';

interface Props {
  objectType: ObjectTypeSlug;
  fields: FieldSpec[];
  visible: string[];                // slugs of visible fields, in display order
  onChange: (next: string[]) => void;
}

export function FieldsPopover({ objectType, fields, visible, onChange }: Props) {
  const [open, setOpen] = useState(false);

  function toggle(slug: string) {
    if (visible.includes(slug)) onChange(visible.filter((s) => s !== slug));
    else onChange([...visible, slug]);
  }

  const hiddenCount = fields.filter((f) => !visible.includes(f.slug)).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12.5px] font-normal">
          {hiddenCount > 0 ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          Fields
          <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{visible.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-0">
        <div className="max-h-72 overflow-auto py-1">
          {fields.map((f) => {
            const on = visible.includes(f.slug);
            return (
              <button
                key={f.slug}
                onClick={() => toggle(f.slug)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] hover:bg-foreground/[0.04]"
              >
                <span className={on ? 'text-foreground' : 'text-muted-foreground'}>{f.label}</span>
                <span className={'inline-flex h-3.5 w-6 items-center rounded-full ' + (on ? 'bg-butter justify-end' : 'bg-muted justify-start')}>
                  <span className="block h-2.5 w-2.5 rounded-full bg-background mx-0.5" />
                </span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-border p-2">
          <NewCustomFieldDialog objectType={objectType}>
            <Button variant="ghost" size="sm" className="w-full h-8 justify-start gap-1.5 text-[12.5px] font-normal">
              <Plus className="h-3.5 w-3.5" /> Create custom field
            </Button>
          </NewCustomFieldDialog>
        </div>
      </PopoverContent>
    </Popover>
  );
}
