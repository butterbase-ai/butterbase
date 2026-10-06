import { useQuery } from '@tanstack/react-query';
import { api } from '@/console/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { SettingsPage } from '@/console/components/SettingsPage';

type ModelEntry = {
  tokens?: number;
  cost?: number;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
};

type AiUsage = {
  totalTokens?: number;
  totalCost?: number;
  byModel?: Record<string, ModelEntry>;
  meetings?: Array<{ date?: string; tokens?: number; cost?: number; requests?: number }>;
};

function fmtNum(n: unknown): string {
  if (n === null || n === undefined) return '—';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString();
}

function fmtUsd(n: unknown): string {
  if (n === null || n === undefined) return '—';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function AISettings() {
  const { data, isLoading, error } = useQuery<AiUsage>({
    queryKey: ['ai-usage'],
    queryFn: async () => api.fetchAiUsage(),
  });

  const models = data?.byModel
    ? Object.entries(data.byModel)
        .map(([name, m]) => ({ name, ...m }))
        .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
    : [];
  const totalRequests = models.reduce((sum, m) => sum + (m.requests ?? 0), 0);
  const maxTokens = Math.max(1, ...models.map((m) => m.tokens ?? 0));
  const meetings = data?.meetings ?? [];
  const maxMeetingTokens = Math.max(1, ...meetings.map((m) => m.tokens ?? 0));

  return (
    <SettingsPage
      label="AI Models"
      title={<>AI <em>usage</em></>}
      description="Token spend, requests, and cost across your models — last 30 days."
    >
      {isLoading && (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent></Card>
      )}
      {error && (
        <Card><CardContent className="p-6 text-sm text-destructive">{(error as any).message || 'Failed to load'}</CardContent></Card>
      )}

      {data && !isLoading && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Total tokens" value={fmtNum(data.totalTokens)} />
            <Stat label="Estimated cost" value={fmtUsd(data.totalCost)} />
            <Stat label="Requests" value={fmtNum(totalRequests)} />
          </div>

          <Card>
            <CardHeader><CardTitle>By model</CardTitle></CardHeader>
            <CardContent>
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">No model usage in this period.</p>
              ) : (
                <div className="space-y-4">
                  {models.map((m) => {
                    const pct = Math.round(((m.tokens ?? 0) / maxTokens) * 100);
                    return (
                      <div key={m.name} className="space-y-2">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-mono text-xs text-caramel/90 truncate">{m.name}</span>
                          <span className="shrink-0 tabular-nums font-mono text-[11px] text-muted-foreground">
                            {fmtNum(m.tokens)} tok · {fmtNum(m.requests)} req · {fmtUsd(m.cost)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-paper-warm overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-caramel to-butter-200 shadow-[0_0_12px_rgba(245,200,66,0.6)]" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {meetings.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Daily activity</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {meetings.map((d, i) => {
                    const pct = Math.round(((d.tokens ?? 0) / maxMeetingTokens) * 100);
                    return (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <div className="w-20 shrink-0 font-mono text-muted-foreground">{d.date || '—'}</div>
                        <div className="flex-1 h-1.5 rounded-full bg-paper-warm overflow-hidden">
                          <div className="h-full bg-caramel/80" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="w-24 shrink-0 text-right tabular-nums font-mono">{fmtNum(d.tokens)} tok</div>
                        <div className="w-20 shrink-0 text-right tabular-nums font-mono text-muted-foreground">{fmtUsd(d.cost)}</div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </SettingsPage>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="grain rounded-2xl border border-rule-soft bg-paper-soft/60 p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{label}</div>
      <div className="mt-2 font-display text-2xl tracking-tight tabular-nums text-foreground">{value ?? '—'}</div>
    </div>
  );
}
