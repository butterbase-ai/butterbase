import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Pencil, ExternalLink } from 'lucide-react';

interface Props {
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Optional render-hint. When 'url', a non-empty value that looks like a URL
   * (or a bare domain / linkedin handle) is rendered as a real anchor tag —
   * clicking the link navigates, clicking the pencil enters edit mode. This
   * fixes the "domain / linkedin_url can't be clicked because clicking edits"
   * complaint on detail pages.
   */
  type?: 'text' | 'url';
  onSave: (next: string) => Promise<void> | void;
  className?: string;
}

function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // linkedin.com/in/foo, example.com/path — assume https.
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(s)) return `https://${s}`;
  return null;
}

export function InlineEditCell({ value, placeholder, disabled, type = 'text', onSave, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(value ?? ''); }, [value]);

  async function commit() {
    if (draft === (value ?? '')) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch {
      setDraft(value ?? '');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
        }}
        className={cn('h-8', className)}
      />
    );
  }

  const href = type === 'url' && value ? normalizeUrl(value) : null;

  if (href) {
    // Render as a real link so clicks navigate; the pencil (visible on hover)
    // is the affordance for entering edit mode.
    return (
      <div className={cn('group flex w-full items-center gap-1 rounded px-2 py-1 text-sm hover:bg-accent/40', className)}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 flex-1 items-center gap-1 truncate text-primary hover:underline"
        >
          <span className="truncate">{value}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
        </a>
        {!disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="invisible rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:visible"
            title="Edit"
            aria-label="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) setEditing(true); }}
      className={cn(
        'group flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm',
        !disabled && 'hover:bg-accent/40',
        className,
      )}
    >
      <span className={cn('truncate', !value && 'text-muted-foreground')}>
        {value || placeholder || '—'}
      </span>
      {!disabled && <Pencil className="invisible h-3 w-3 text-muted-foreground group-hover:visible" />}
    </button>
  );
}
