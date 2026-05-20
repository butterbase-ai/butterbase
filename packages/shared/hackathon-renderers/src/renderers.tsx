import type { Field } from './types.js';

export function shortHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

export function renderValue(value: unknown, field: Field, mode: 'cell' | 'detail'): React.ReactNode {
  if (value === undefined || value === null || value === '') return <span className="text-zinc-400">—</span>;
  switch (field.type) {
    case 'text': return <span>{String(value)}</span>;
    case 'url':  return <a href={String(value)} target="_blank" rel="noopener" className="text-blue-600 underline">{shortHost(String(value))}</a>;
    case 'email': return <a href={`mailto:${value}`} className="text-blue-600 underline">{String(value)}</a>;
    case 'image_url': return <img src={String(value)} alt="" className="h-10 rounded" />;
    case 'number': return <span className="tabular-nums">{Number(value)}</span>;
    case 'enum': return <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs">{String(value)}</span>;
    case 'text[]': return (
      <span className="flex flex-wrap gap-1">
        {(value as string[]).map((v, i) => <span key={i} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{v}</span>)}
      </span>
    );
    case 'markdown': return mode === 'cell' ? <span className="line-clamp-1">{String(value).replace(/[#*_`>]/g, '')}</span> : <pre className="whitespace-pre-wrap text-sm">{String(value)}</pre>;
    default: return <code className="text-xs">{JSON.stringify(value)}</code>;
  }
}
