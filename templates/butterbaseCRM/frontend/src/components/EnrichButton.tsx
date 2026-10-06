import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { bbInvoke } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';

// Invokes enrich-company / enrich-person against the Butterbase People API
// primitive and refreshes the entity's cached React Query state. See
// backend/functions/enrich-{person,company}/handler.ts for the write path
// (substrate patch_entity → row updates through the substrate stream).

interface EnrichResponse {
  ok: boolean;
  status: string;
  patched_fields?: string[];
  reason?: string;
  error?: string;
  usage?: { credits: number; usd: number };
}

interface Props {
  kind: 'company' | 'person';
  entityId: string;
}

export function EnrichButton({ kind, entityId }: Props) {
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const ws = useCurrentWorkspaceId();

  async function run() {
    if (!entityId || busy) return;
    setBusy(true);
    try {
      const fn = kind === 'company' ? 'enrich-company' : 'enrich-person';
      const payload = kind === 'company' ? { company_id: entityId } : { person_id: entityId };
      const { data, error } = await bbInvoke<EnrichResponse>(fn, payload);
      if (error) throw new Error(typeof error === 'string' ? error : (error?.error ?? error?.message ?? 'Enrichment failed'));
      const status = data?.status;
      if (status === 'people_api_ok') {
        const n = data?.patched_fields?.length ?? 0;
        toast.success(n ? `Filled ${n} field${n === 1 ? '' : 's'} from LinkedIn` : 'Enriched');
      } else if (status === 'no_signal') {
        toast.info(data?.reason ?? (kind === 'company'
          ? 'Add a person with a LinkedIn URL to this company, then re-enrich'
          : 'Add a LinkedIn URL or name + company to enrich this person'));
      } else if (status === 'no_match') {
        toast.info('No match found in the People API');
      } else if (status === 'error') {
        toast.error(data?.error ?? 'Enrichment failed');
      } else {
        toast.info(`Enrichment returned: ${status ?? 'unknown'}`);
      }
      // Refresh caches — the enrich functions write via ctx.substrate.propose,
      // which lands on the entity but doesn't (yet) push through the WS stream.
      if (kind === 'company') {
        qc.invalidateQueries({ queryKey: qk.company(entityId) });
        qc.invalidateQueries({ queryKey: ['company_raw_attrs', entityId] });
        if (ws) qc.invalidateQueries({ queryKey: qk.companies(ws) });
      } else {
        qc.invalidateQueries({ queryKey: qk.person(entityId) });
        qc.invalidateQueries({ queryKey: ['person_raw_attrs', entityId] });
        if (ws) qc.invalidateQueries({ queryKey: qk.people(ws) });
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Enrichment failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={run} disabled={busy} className="gap-1.5">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {busy ? 'Enriching…' : 'Enrich with AI'}
    </Button>
  );
}
