// frontend/src/components/LeadResultsTable.tsx
import { ExternalLink } from 'lucide-react';
import type { SearchResult } from '@/lib/leadFinder';

interface Props {
  results: SearchResult[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

export function LeadResultsTable({ results, selectedIds, onToggle, onToggleAll }: Props) {
  const allSelected = results.length > 0 && results.every((r) => selectedIds.has(r.external_id));
  const someSelected = !allSelected && results.some((r) => selectedIds.has(r.external_id));

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30 text-left">
          <tr>
            <th className="px-3 py-2 w-8">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected; }}
                onChange={onToggleAll}
                disabled={results.length === 0}
              />
            </th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Company</th>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2 w-12">LinkedIn</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const checked = selectedIds.has(r.external_id);
            return (
              <tr
                key={r.external_id}
                className={`border-b last:border-0 hover:bg-muted/20 cursor-pointer ${checked ? 'bg-muted/30' : ''}`}
                onClick={() => onToggle(r.external_id)}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.full_name}`}
                    checked={checked}
                    onChange={() => onToggle(r.external_id)}
                  />
                </td>
                <td className="px-3 py-2 font-medium">{r.full_name}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.title ?? '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.company_name ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {r.email_masked ?? '—'}
                </td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  {r.linkedin_url ? (
                    <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="inline-flex items-center text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : '—'}
                </td>
              </tr>
            );
          })}
          {results.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground text-sm">No results yet — run a search.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
