import { Sparkles, X, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { PatternSignal } from '@/console/lib/types';

export function PatternBanner({
  pattern,
  onDismiss,
}: {
  pattern: PatternSignal;
  onDismiss?: () => void;
}) {
  return (
    <div className="relative overflow-hidden border-b border-butter-300/60 bg-gradient-to-r from-caramel/[0.08] via-crust/[0.04] to-transparent">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(245,200,66,0.06),transparent)] animate-shimmer" style={{ backgroundSize: '200% 100%' }} />
      <div className="relative flex items-center gap-3 px-8 py-3 text-sm">
        <div className="grid h-6 w-6 place-items-center rounded-full bg-butter-200 text-caramel">
          <Sparkles className="h-3 w-3" />
        </div>
        <Link to="/patterns" className="flex-1 truncate group">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-caramel/80 mr-2">
            ▲ Pattern · {pattern.signal_kind}
          </span>
          <span className="font-medium text-foreground group-hover:text-caramel-deep transition-colors">{pattern.signal_key}</span>{' '}
          <span className="text-muted-foreground">— seen {pattern.count}×</span>
        </Link>
        <Link
          to="/patterns"
          className="inline-flex items-center gap-1 rounded-full border border-butter-300/60 bg-butter-100 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-caramel-deep hover:bg-butter-200 transition-colors"
        >
          Investigate <ArrowUpRight className="h-3 w-3" />
        </Link>
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-paper-warm hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
