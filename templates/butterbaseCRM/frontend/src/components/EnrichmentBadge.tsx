import { formatDistanceToNowStrict } from 'date-fns';
import { Sparkles, CircleDashed, AlertCircle } from 'lucide-react';

interface Props {
  status: string | null;
  at: string | null;
}

/**
 * Tiny inline status pill rendered next to a company/person header.
 * Encodes the four states the enrich-* functions write — see
 * backend/functions/enrich-company/handler.ts.
 */
export function EnrichmentBadge({ status, at }: Props) {
  if (!status) return null;

  let label = status;
  let tone: 'ok' | 'muted' | 'warn' = 'muted';
  let Icon = CircleDashed;

  if (status === 'pdl_ok') {
    label = 'Enriched';
    tone = 'ok';
    Icon = Sparkles;
  } else if (status === 'fallback_ok') {
    label = 'Enriched (web)';
    tone = 'ok';
    Icon = Sparkles;
  } else if (status === 'no_match' || status === 'no_domain' || status === 'no_email') {
    label = status === 'no_domain' ? 'No domain to enrich' : status === 'no_email' ? 'No email to enrich' : 'Not found in enrichment sources';
    tone = 'muted';
  } else if (status === 'not_configured') {
    label = 'Enrichment not configured';
    tone = 'muted';
  } else if (status.startsWith('error:')) {
    label = 'Enrichment failed';
    tone = 'warn';
    Icon = AlertCircle;
  }

  const colour =
    tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
    : tone === 'warn' ? 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border-amber-500/30'
    : 'text-muted-foreground bg-muted/40 border-border';

  return (
    <span
      title={at ? `${status} · ${formatDistanceToNowStrict(new Date(at), { addSuffix: true })}` : status}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${colour}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
