import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { LayoutGrid, Table as TableIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import { NewDealDialog } from '@/components/NewDealDialog';
import { DealCard } from '@/components/DealCard';
import { useDeals, useUpdateDeal } from '@/hooks/useDeals';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { Deal, DealStage } from '@/lib/types';
import { ObjectToolbar } from '@/components/toolbar/ObjectToolbar';
import { useObjectView } from '@/components/toolbar/useObjectView';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { rowMatches, parseCustomFieldRef } from '@/lib/filterDsl';

const STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const STAGE_LABELS: Record<DealStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

function DealColumn({ stage, deals }: { stage: DealStage; deals: Deal[] }) {
  const { setNodeRef } = useDroppable({ id: `col-${stage}` });

  const columnAmount = deals.reduce((sum, d) => sum + (d.amount_cents || 0), 0);
  const columnAmountFormatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(columnAmount / 100);

  const stageIndex = STAGES.indexOf(stage) + 1;
  const isTerminal = stage === 'won' || stage === 'lost';

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col w-full min-w-[280px] rounded-lg bg-card/40 border border-border p-3.5"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground num">
              {String(stageIndex).padStart(2, '0')}
            </span>
            <span className={`h-1.5 w-1.5 rounded-full ${
              stage === 'won' ? 'bg-sage' :
              stage === 'lost' ? 'bg-coral' :
              'bg-butter'
            }`} />
            <h3 className="font-display text-[16px] tracking-tight text-foreground truncate">
              {STAGE_LABELS[stage]}
            </h3>
          </div>
          <p className="mt-1 eyebrow !text-[9.5px]">
            {deals.length} {deals.length === 1 ? 'deal' : 'deals'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`font-mono text-[11px] font-medium num ${isTerminal ? 'text-muted-foreground' : 'text-foreground'}`}>
            {columnAmountFormatted}
          </p>
        </div>
      </div>

      <div className="rule-dotted mb-3" />

      <div className="flex-1 space-y-2 min-h-0">
        <SortableContext items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
          {deals.length === 0 ? (
            <div className="flex items-center justify-center py-10 font-editorial italic text-[13px] text-muted-foreground/70">
              — empty —
            </div>
          ) : (
            deals.map((d) => <DealCard key={d.id} deal={d} />)
          )}
        </SortableContext>
      </div>
    </div>
  );
}

export default function DealsKanban() {
  const { data: allDeals = [], isLoading } = useDeals();
  const updateMut = useUpdateDeal();
  const qc = useQueryClient();
  const ws = useCurrentWorkspaceId();
  const v = useObjectView('deals');
  const cvLookup = useCustomValueLookup('deals');
  const [mode, setMode] = useState<'kanban' | 'table'>('kanban');

  const deals = useMemo(() => {
    const filtered = v.filters.length === 0 ? allDeals : allDeals.filter((d) =>
      v.filters.every((f) => rowMatches(d, f, (row, ref) => {
        const id = parseCustomFieldRef(ref);
        return id ? cvLookup.get(row.id, id) : null;
      })),
    );
    if (!v.sort) return filtered;
    const dir = v.sort.direction === 'asc' ? 1 : -1;
    const field = v.sort.field;
    return [...filtered].sort((a: any, b: any) => {
      const av = a?.[field] ?? ''; const bv = b?.[field] ?? '';
      return av > bv ? dir : av < bv ? -dir : 0;
    });
  }, [allDeals, v.filters, v.sort, cvLookup]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const dealsByStage = useMemo(() => {
    const grouped: Record<DealStage, Deal[]> = {
      lead: [],
      qualified: [],
      proposal: [],
      negotiation: [],
      won: [],
      lost: [],
    };
    deals.forEach((d) => {
      grouped[d.stage].push(d);
    });
    return grouped;
  }, [deals]);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const draggedDeal = deals.find((d) => d.id === active.id);
    if (!draggedDeal) return;

    let targetStage = draggedDeal.stage;
    if (typeof over.id === 'string' && over.id.startsWith('col-')) {
      const stageKey = over.id.slice(4);
      if (STAGES.includes(stageKey as DealStage)) {
        targetStage = stageKey as DealStage;
      }
    } else {
      const overDeal = deals.find((d) => d.id === over.id);
      if (overDeal) {
        targetStage = overDeal.stage;
      }
    }

    if (targetStage === draggedDeal.stage) return;

    try {
      qc.setQueryData(qk.deals(ws), (oldData: Deal[] | undefined) =>
        (oldData ?? []).map((d) => (d.id === draggedDeal.id ? { ...d, stage: targetStage } : d)),
      );

      await updateMut.mutateAsync({
        id: draggedDeal.id,
        patch: { stage: targetStage },
        previousStage: draggedDeal.stage,
      });
    } catch (e) {
      qc.invalidateQueries({ queryKey: qk.deals(ws) });
      toast.error(e instanceof Error ? e.message : 'Failed to update deal');
    }
  }

  const totalValue = deals
    .filter((d) => d.stage !== 'lost')
    .reduce((sum, d) => sum + (d.amount_cents || 0), 0);
  const totalFmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(totalValue / 100);

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 03 · Pipeline</p>
          <h1 className="page-title">
            Deals <em>in motion</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Drag a card to advance its stage. {deals.length} active · {totalFmt} weighted.
          </p>
        </div>
        <NewDealDialog />
      </div>

      <div className="flex items-center gap-2 px-8 py-2 border-b border-border bg-background/40">
        <div className="inline-flex rounded-md border border-border bg-card p-0.5">
          <button
            onClick={() => setMode('kanban')}
            className={cn('h-7 px-2.5 rounded text-[12px] flex items-center gap-1.5 transition-colors',
              mode === 'kanban' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
          >
            <LayoutGrid className="h-3 w-3" /> Kanban
          </button>
          <button
            onClick={() => setMode('table')}
            className={cn('h-7 px-2.5 rounded text-[12px] flex items-center gap-1.5 transition-colors',
              mode === 'table' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
          >
            <TableIcon className="h-3 w-3" /> Table
          </button>
        </div>
      </div>
      <ObjectToolbar objectType="deals" />

      <div className="flex-1 overflow-auto px-8 py-6">
        {isLoading ? (
          mode === 'table'
            ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            : <div className="font-editorial italic text-muted-foreground">Loading the ledger…</div>
        ) : mode === 'kanban' ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="flex gap-4 pb-4">
              {STAGES.map((stage) => (
                <DealColumn key={stage} stage={stage} deals={dealsByStage[stage]} />
              ))}
            </div>
          </DndContext>
        ) : (
          <DealsTable deals={deals} visibleFields={v.visibleFields} cvLookup={cvLookup} />
        )}
      </div>
    </div>
  );
}

function dealLabel(slug: string): string {
  switch (slug) {
    case 'name': return 'Deal';
    case 'stage': return 'Stage';
    case 'amount_cents': return 'Amount';
    case 'currency': return 'Currency';
    case 'close_date': return 'Close date';
    case 'created_at': return 'Created';
    case 'updated_at': return 'Updated';
    default: return slug;
  }
}

function renderDealBuiltin(d: Deal, slug: string) {
  if (slug === 'amount_cents') {
    const amt = d.amount_cents
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: d.currency || 'USD', maximumFractionDigits: 0 }).format(d.amount_cents / 100)
      : null;
    return <span className="font-mono num">{amt ?? '—'}</span>;
  }
  if (slug === 'stage') {
    return <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs">{d.stage}</span>;
  }
  if (slug === 'close_date' || slug === 'created_at' || slug === 'updated_at') {
    const v = (d as any)[slug];
    return <span className="text-muted-foreground">{v ? formatDistanceToNowStrict(new Date(v), { addSuffix: true }) : '—'}</span>;
  }
  return (d as any)[slug] ?? '—';
}

function DealsTable({ deals, visibleFields, cvLookup }: { deals: Deal[]; visibleFields: string[]; cvLookup: ReturnType<typeof useCustomValueLookup> }) {
  const visibleBuilt = visibleFields.filter((s) => !parseCustomFieldRef(s));
  const visibleCustom = visibleFields.map(parseCustomFieldRef).filter((x): x is string => !!x);
  if (deals.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h3 className="font-medium">No matches</h3>
        <p className="mt-1 text-sm text-muted-foreground">Adjust filters or switch to Kanban for the full pipeline.</p>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {visibleBuilt.map((slug) => <TableHead key={slug}>{dealLabel(slug)}</TableHead>)}
          {visibleCustom.map((id) => {
            const f = cvLookup.fields.find((x) => x.id === id);
            return <TableHead key={id}>{f?.name ?? '—'}</TableHead>;
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {deals.map((d) => (
          <TableRow key={d.id} className="hover:bg-butter/[0.04]">
            {visibleBuilt.map((slug) => (
              <TableCell key={slug} className="text-sm">{renderDealBuiltin(d, slug)}</TableCell>
            ))}
            {visibleCustom.map((id) => (
              <TableCell key={id} className="text-sm">
                <CustomFieldCell field={cvLookup.fields.find((x) => x.id === id)} entityId={d.id} value={cvLookup.get(d.id, id)} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
