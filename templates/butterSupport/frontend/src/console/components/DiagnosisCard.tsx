import { useState } from 'react';
import { Badge } from '@/console/components/ui/badge';
import { Button } from '@/console/components/ui/button';
import { Textarea } from '@/console/components/ui/textarea';
import type { Diagnosis } from '@/console/lib/types';
import { Stethoscope, ChevronDown } from 'lucide-react';

export function DiagnosisCard({
  diagnosis,
  onRerun,
  readonly,
}: {
  diagnosis: Diagnosis | null;
  onRerun: (hint: string) => void;
  readonly?: boolean;
}) {
  const [hint, setHint] = useState('');
  const [open, setOpen] = useState(false);

  if (!diagnosis) {
    return (
      <div className="p-5">
        <div className="section-label mb-2">No diagnosis yet</div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Click <span className="text-caramel">Diagnose</span> on the ticket toolbar to start.
        </p>
      </div>
    );
  }

  const confColor =
    diagnosis.confidence === 'high'
      ? 'green'
      : diagnosis.confidence === 'med' || diagnosis.confidence === 'medium'
      ? 'amber'
      : 'red';

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-butter-100 text-caramel">
          <Stethoscope className="h-3.5 w-3.5" />
        </div>
        <Badge variant={confColor as any}>{diagnosis.confidence} confidence</Badge>
      </div>
      <div className="rounded-2xl border border-rule-soft bg-paper-soft px-4 py-3.5 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
        {diagnosis.summary}
      </div>
      {diagnosis.evidence && diagnosis.evidence.length > 0 && (
        <div>
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-caramel transition-colors"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
            {open ? 'Hide' : 'Show'} evidence · {diagnosis.evidence.length}
          </button>
          {open && (
            <ul className="mt-3 space-y-2">
              {diagnosis.evidence.map((e, i) => (
                <li key={i} className="rounded-xl border border-rule-soft bg-paper-warm p-3 text-xs">
                  <div className="font-mono text-caramel/90 text-[11px] uppercase tracking-wider">{e.source}</div>
                  <div className="mt-1.5 text-foreground/80 leading-relaxed">{e.excerpt}</div>
                  {typeof e.score === 'number' && (
                    <div className="mt-1.5 font-mono text-[10px] text-muted-foreground/70">score · {e.score.toFixed(3)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!readonly && import.meta.env.VITE_ENABLE_RERUN_WITH_HINT === 'true' && (
        <div className="pt-3 border-t border-rule-soft space-y-2">
          <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Rerun with hint</label>
          <Textarea
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="e.g. focus on billing edge cases"
            className="text-sm"
          />
          <Button size="sm" onClick={() => { onRerun(hint); setHint(''); }} disabled={!hint.trim()}>
            Rerun diagnosis
          </Button>
        </div>
      )}
    </div>
  );
}
