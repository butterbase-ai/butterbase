import { AlertTriangle, AlertOctagon } from 'lucide-react';
import { Button } from '@/console/components/ui/button';
import { toast } from '@/console/components/ui/toast';
import { timeAgo } from '@/console/lib/utils';
import type { Escalation } from '@/console/lib/types';

export function EscalationBar({ escalation }: { escalation: Escalation }) {
  const failed = escalation.status === 'failed';
  const Icon = failed ? AlertOctagon : AlertTriangle;
  return (
    <div
      className={`flex items-center gap-3 border-b px-7 py-2.5 text-sm ${
        failed
          ? 'border-destructive/30 bg-destructive/[0.08] text-destructive'
          : 'border-caramel/30 bg-butter-100 text-caramel'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1">
        <span className="font-mono uppercase tracking-[0.18em] text-[10px] mr-2 opacity-80">Escalated</span>
        <span className="text-foreground/90">{escalation.reason || '—'}</span>
        <span className="text-muted-foreground"> · {escalation.status}</span>
        {escalation.sent_at && <span className="text-muted-foreground"> · sent {timeAgo(escalation.sent_at)}</span>}
      </div>
      {failed && (
        <Button size="sm" variant="outline" onClick={() => toast.info('Retry not yet wired — contact admin.')}>
          Retry
        </Button>
      )}
    </div>
  );
}
