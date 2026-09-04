import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, Sparkles, Search } from 'lucide-react';
import { bb } from '@/lib/butterbase';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { SaveListFromSearchDialog } from '@/components/SaveListFromSearchDialog';

interface SearchResult {
  table: 'companies' | 'people' | 'deals';
  spec: any;
  rows: any[];
  count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EXAMPLES = [
  'companies in fintech with more than 50 employees',
  'people with engineer in title',
  'open deals over 10000',
  'deals closing this month',
];

export function AISearchDialog({ open, onOpenChange }: Props) {
  const ws = useCurrentWorkspaceId();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResult(null);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  async function run(q: string) {
    if (!q.trim() || !ws) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data, error } = await bb.functions.invoke('ai-search', {
        body: { query: q, workspace_id: ws },
      });
      if (error) throw error;
      setResult(data as SearchResult);
    } catch (e: any) {
      setError(e?.message ?? 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  function handleRowClick(row: any) {
    if (!result) return;
    onOpenChange(false);
    if (result.table === 'companies') navigate(`/companies/${row.id}`);
    else if (result.table === 'people') navigate(`/people`);
    else if (result.table === 'deals') navigate(`/deals`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display tracking-tight">
            <Sparkles className="h-4 w-4 text-butter" />
            AI search
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(query);
            }}
            className="flex gap-2"
          >
            <Input
              autoFocus
              placeholder="Ask in plain English — e.g. open deals over 10k"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 h-10"
            />
            <Button type="submit" disabled={loading || !query.trim()} className="h-10 px-4 gap-2 bg-foreground text-background hover:bg-foreground/85">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              Search
            </Button>
          </form>

          {!result && !loading && !error && (
            <div className="space-y-1.5">
              <p className="eyebrow">Try</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => {
                      setQuery(ex);
                      run(ex);
                    }}
                    className="text-[12.5px] px-2.5 py-1 rounded-md border border-border bg-card/50 text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="space-y-2 pt-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}

          {error && (
            <p className="text-[13px] text-coral font-mono pt-2">{error}</p>
          )}

          {result && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <p className="eyebrow">
                  {result.count} {result.table} · {result.spec?.filters?.length ?? 0} filters
                </p>
                <div className="flex items-center gap-2">
                  {(result.table === 'people' || result.table === 'companies') && result.count > 0 && (
                    <SaveListFromSearchDialog
                      spec={result.spec}
                      entityType={result.table}
                      count={result.count}
                      memberIds={result.rows.map((r: any) => r.id).filter((x: any): x is string => typeof x === 'string')}
                      onSaved={() => onOpenChange(false)}
                    />
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {result.table}
                  </span>
                </div>
              </div>
              {result.count === 0 ? (
                <p className="font-editorial italic text-[13px] text-muted-foreground py-4 text-center">
                  No matches. Try a broader phrasing.
                </p>
              ) : (
                <ul className="max-h-72 overflow-auto divide-y divide-border border border-border rounded-md">
                  {result.rows.map((row) => (
                    <li
                      key={row.id}
                      onClick={() => handleRowClick(row)}
                      className="px-3 py-2.5 hover:bg-foreground/[0.03] cursor-pointer transition-colors"
                    >
                      <ResultRow row={row} table={result.table} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({ row, table }: { row: any; table: 'companies' | 'people' | 'deals' }) {
  if (table === 'companies') {
    return (
      <div>
        <p className="text-[13.5px] text-foreground">{row.name}</p>
        <p className="font-editorial italic text-[12px] text-muted-foreground">
          {[row.domain, row.industry, row.location].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>
    );
  }
  if (table === 'people') {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email;
    return (
      <div>
        <p className="text-[13.5px] text-foreground">{name}</p>
        <p className="font-editorial italic text-[12px] text-muted-foreground">
          {[row.title, row.email].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[13.5px] text-foreground">{row.name}</p>
      <p className="font-editorial italic text-[12px] text-muted-foreground">
        {row.stage} · {row.amount_cents != null ? `${(row.amount_cents / 100).toLocaleString()} ${row.currency ?? ''}` : '—'}
      </p>
    </div>
  );
}
