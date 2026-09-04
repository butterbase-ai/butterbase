// frontend/src/pages/LeadFinder.tsx
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bb } from '@/lib/butterbase';
import { Button } from '@/components/ui/button';
import { LeadSearchBox } from '@/components/LeadSearchBox';
import { LeadResultsTable } from '@/components/LeadResultsTable';
import { AddToListDialog } from '@/components/AddToListDialog';
import type { SearchResponse, SearchResult } from '@/lib/leadFinder';

// HARD CAP — single page, max 100. Backend enforces the same cap.
const PAGE_SIZE = 100;

async function fetchPage(query: string): Promise<SearchResponse> {
  const { data, error: invokeErr } = await bb.functions.invoke('lead-search', {
    body: { query, page_size: PAGE_SIZE },
  });
  if (invokeErr) throw invokeErr;
  return data as SearchResponse;
}

export default function LeadFinder() {
  const navigate = useNavigate();
  const [queryText, setQueryText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [meta, setMeta] = useState<{ query_hash: string; total_count: number; from_cache: boolean; provider: string; usage?: { credits: number; usd: number } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const runSearch = useCallback(async () => {
    if (!queryText.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const d = await fetchPage(queryText);
      setResults(d.results);
      setMeta({ query_hash: d.query_hash, total_count: d.total_count, from_cache: d.from_cache, provider: d.provider, usage: d.usage });
      // Default: pre-select every result so the "add all" flow still works
      // in one click; users can uncheck the ones they don't want.
      setSelectedIds(new Set(d.results.map((r) => r.external_id)));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setResults([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [queryText]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (results.length > 0 && results.every((r) => prev.has(r.external_id))) return new Set();
      return new Set(results.map((r) => r.external_id));
    });
  }, [results]);

  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Lead Finder</h1>
        <p className="text-sm text-muted-foreground">
          Search for people by role, industry, and location. Add to a list to reveal emails.
        </p>
      </div>

      <div className="space-y-4">
        <LeadSearchBox
          onSubmit={runSearch}
          loading={loading}
          queryText={queryText}
          onQueryTextChange={setQueryText}
        />

        {error && (
          <div className="text-sm text-destructive border border-destructive/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        {meta && (
          <div className="text-sm text-muted-foreground flex items-center flex-wrap gap-x-2">
            <span>
              Showing {results.length.toLocaleString()} of {meta.total_count.toLocaleString()} matches
              {meta.total_count > results.length && <span className="ml-1">— refine filters to narrow.</span>}
            </span>
            {meta.from_cache ? (
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px] uppercase tracking-wide">cached · free</span>
            ) : meta.usage && (meta.usage.credits > 0 || meta.usage.usd > 0) ? (
              <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] uppercase tracking-wide">
                cost: {meta.usage.credits} credits · ${meta.usage.usd.toFixed(3)}
              </span>
            ) : null}
          </div>
        )}

        <LeadResultsTable
          results={results}
          selectedIds={selectedIds}
          onToggle={toggleOne}
          onToggleAll={toggleAll}
        />

        {results.length > 0 && (
          <div className="sticky bottom-4 flex items-center justify-between rounded-md border bg-background p-3 shadow-sm">
            <div className="text-sm">
              {selectedIds.size.toLocaleString()} of {results.length.toLocaleString()} selected
            </div>
            <Button
              onClick={() => setDialogOpen(true)}
              disabled={selectedIds.size === 0}
            >
              Add {selectedIds.size > 0 ? selectedIds.size : ''} to list…
            </Button>
          </div>
        )}

        {meta && (
          <AddToListDialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            queryHash={meta.query_hash}
            selectedIds={selectedArray}
            onSaved={(info) => {
              if (info.list_id) {
                navigate(`/campaigns?list_id=${info.list_id}`);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
