import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { formatDistanceToNowStrict } from 'date-fns';
import type { Deal } from '@/lib/types';

export function DealCard({ deal }: { deal: Deal }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  const amount = deal.amount_cents && deal.amount_cents > 0
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: deal.currency || 'USD',
        maximumFractionDigits: 0,
      }).format(deal.amount_cents / 100)
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group relative cursor-grab active:cursor-grabbing rounded-md border border-border bg-card px-3.5 py-3 transition-all hover:border-foreground/30 hover:-translate-y-0.5"
    >
      {/* left butter mark */}
      <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full bg-butter/0 group-hover:bg-butter transition-colors" />

      <div className="flex items-start justify-between gap-2">
        <h4 className="font-display text-[15px] leading-snug text-foreground truncate tracking-tight">
          {deal.name}
        </h4>
        {amount && (
          <span className="shrink-0 font-mono text-[11px] font-medium text-foreground num">
            {amount}
          </span>
        )}
      </div>

      {deal.close_date && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/60" />
          <p className="font-editorial italic text-[12px] text-muted-foreground">
            closes {formatDistanceToNowStrict(new Date(deal.close_date), { addSuffix: true })}
          </p>
        </div>
      )}
    </div>
  );
}
