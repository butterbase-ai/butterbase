import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bb } from '@/lib/butterbase';

interface Props {
  label: string;
  endpoint: string; // e.g. '/fn/ingest-gmail'
  body: any;
  cost_estimate?: string | null;
  onResolved: (ok: boolean, result?: any) => void;
}

export function ConfirmActionCard({ label, endpoint, body, cost_estimate, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const fnName = endpoint.replace(/^\/fn\//, '');
      const { data, error } = await (bb.functions as any).invoke(fnName, { body });
      if (error) throw error;
      onResolved(true, data);
    } catch (e: any) {
      setError(e?.message ?? 'failed');
      onResolved(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[13.5px]">{label}</p>
        {cost_estimate && <span className="text-[11px] font-mono text-muted-foreground">{cost_estimate}</span>}
      </div>
      <Button size="sm" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run'}</Button>
      {error && <p className="text-[12px] text-coral font-mono">{error}</p>}
    </div>
  );
}
