import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props { name: string; status: 'running' | 'done' | 'error'; summary?: string; error?: string }

export function ToolCallChip({ name, status, summary, error }: Props) {
  const Icon = status === 'running' ? Loader2 : status === 'done' ? CheckCircle2 : AlertCircle;
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2 py-0.5 text-[11.5px] font-mono">
      <Icon className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''} ${status === 'error' ? 'text-coral' : 'text-muted-foreground'}`} />
      <span>{name}</span>
      {summary && <span className="text-muted-foreground">· {summary}</span>}
      {error && <span className="text-coral">· {error}</span>}
    </div>
  );
}
