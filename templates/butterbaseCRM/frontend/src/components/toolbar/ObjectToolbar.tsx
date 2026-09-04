import { ArrowDownAZ } from 'lucide-react';
import { AISearchButton } from './AISearchButton';
import { FieldsPopover } from './FieldsPopover';
import { FilterPopover } from './FilterPopover';
import { SavedViewsMenu } from './SavedViewsMenu';
import { SaveListFromSearchDialog } from '@/components/SaveListFromSearchDialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ObjectTypeSlug } from '@/lib/types';
import { useObjectView } from './useObjectView';

interface Props {
  objectType: ObjectTypeSlug;
  /** Currently visible row ids — required to expose "Save as list" for people/companies. */
  filteredIds?: string[];
}

export function ObjectToolbar({ objectType, filteredIds }: Props) {
  const v = useObjectView(objectType);
  const canSaveList = (objectType === 'people' || objectType === 'companies') && Array.isArray(filteredIds);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/40 px-8 py-2">
      <SavedViewsMenu
        objectType={objectType}
        activeView={v.activeView}
        filters={v.filters}
        sort={v.sort}
        visibleFields={v.visibleFields}
        onSelect={v.setActiveView}
      />
      {v.isDirty && (
        <span className="font-mono text-[10px] text-amber-700 ml-1">· unsaved</span>
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <AISearchButton
        objectType={objectType}
        customFields={v.customFields ?? []}
        onApply={({ filters, sort }) => {
          v.setFilters(filters);
          if (sort) v.setSort(sort);
        }}
      />
      <FieldsPopover
        objectType={objectType}
        fields={v.fields}
        visible={v.visibleFields}
        onChange={v.setVisibleFields}
      />
      <FilterPopover
        fields={v.fields}
        filters={v.filters}
        onChange={v.setFilters}
      />
      <Select value={v.sort?.field ?? ''} onValueChange={(field) => {
        if (!field) v.setSort(null);
        else v.setSort({ field, direction: v.sort?.direction ?? 'desc' });
      }}>
        <SelectTrigger className="h-8 w-[160px] text-[12.5px] gap-1.5">
          <ArrowDownAZ className="h-3.5 w-3.5" />
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent>
          {v.fields.map((f) => (
            <SelectItem key={f.slug} value={f.slug}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {v.sort && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-[11px] font-mono"
          onClick={() => v.setSort({ field: v.sort!.field, direction: v.sort!.direction === 'asc' ? 'desc' : 'asc' })}
        >
          {v.sort.direction.toUpperCase()}
        </Button>
      )}
      {canSaveList && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <SaveListFromSearchDialog
            entityType={objectType as 'people' | 'companies'}
            count={filteredIds!.length}
            memberIds={filteredIds!}
          />
        </>
      )}
    </div>
  );
}
