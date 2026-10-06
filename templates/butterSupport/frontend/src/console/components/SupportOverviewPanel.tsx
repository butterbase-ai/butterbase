import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Loader2, X, Sparkles } from 'lucide-react';
import { api } from '@/console/lib/api';

const QUICK_PROMPTS = [
  "What's the state of support right now?",
  'Which tickets have been waiting longest?',
  'Any cross-cutting patterns to look at?',
];

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const TICKET_LINK_RE = /__TICKET__([0-9a-f-]{36})__/;

// Render the agent's markdown output. Bare UUIDs in the text get rewritten as
// markdown links with a sentinel href so we can intercept them in the `a`
// component override and route through react-router instead of a hard nav.
function RenderedAnswer({ text }: { text: string }) {
  const withLinks = text.replace(UUID_RE, (uuid) => `[\`${uuid.slice(0, 8)}\`](__TICKET__${uuid}__)`);
  return (
    <div className="prose-msg text-sm leading-relaxed text-ink">
      <ReactMarkdown
        components={{
          a: ({ href, children, ...rest }) => {
            const m = href?.match(TICKET_LINK_RE);
            if (m) {
              return (
                <Link to={`/inbox/${m[1]}`} className="font-mono">
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {withLinks}
      </ReactMarkdown>
    </div>
  );
}

export function SupportOverviewPanel() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Global ⌘K / Ctrl-K opens the panel from anywhere in the console.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function ask(message: string) {
    if (!message.trim() || busy) return;
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const out = await api.runSupportOverview({ message: message.trim() });
      if (reqIdRef.current === reqId) setAnswer(out.value);
    } catch (e: any) {
      if (reqIdRef.current === reqId) setError(e?.message || 'Failed');
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden lg:flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card/50 text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-[13px]"
      >
        <Sparkles className="h-3.5 w-3.5 text-butter" strokeWidth={1.75} />
        <span>AI search</span>
        <span className="ml-3 font-mono text-[10px] px-1.5 py-0.5 rounded bg-background border border-border num">⌘K</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/30 p-6 pt-24 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-lg animate-rise"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Sparkles className="h-4 w-4 text-butter" strokeWidth={1.75} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') ask(query);
                }}
                placeholder="Ask about support — e.g. what's the state right now?"
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {busy && <Loader2 className="h-4 w-4 animate-spin text-butter" />}
              <button
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
              {!answer && !error && !busy && (
                <div className="space-y-1">
                  <div className="px-1 pb-2 eyebrow !text-[9.5px]">Try</div>
                  {QUICK_PROMPTS.map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        setQuery(q);
                        ask(q);
                      }}
                      className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      <span className="text-butter/60 group-hover:text-butter">→</span>
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {busy && !answer && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-butter animate-pulse-soft" />
                  Asking the support-overview agent…
                </div>
              )}
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                  {error}
                </div>
              )}
              {answer && <RenderedAnswer text={answer} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
