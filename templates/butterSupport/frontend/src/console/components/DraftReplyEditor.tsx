import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/console/components/ui/button';
import { Textarea } from '@/console/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/console/components/ui/tabs';
import { api } from '@/console/lib/api';
import { toast } from '@/console/components/ui/toast';
import type { SupportMessage } from '@/console/lib/types';

export function DraftReplyEditor({
  ticketId,
  draft,
  onSent,
  readonly,
}: {
  ticketId: string;
  draft: SupportMessage | null;
  onSent: () => void;
  readonly?: boolean;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [touched, setTouched] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-expand when a fresh AI draft arrives so the owner can see it.
  useEffect(() => {
    if (draft?.id) setCollapsed(false);
  }, [draft?.id]);

  // Pre-fill from the latest AI draft, but only until the owner starts typing.
  // Once they've touched the textbox, incoming drafts shouldn't clobber their text.
  useEffect(() => {
    if (touched) return;
    if (draft?.body) setBody(draft.body);
  }, [draft?.id, draft?.body, touched]);

  async function send(markResolved: boolean) {
    if (!body.trim()) return;
    setSending(true);
    try {
      await api.sendDraftReply({
        ticket_id: ticketId,
        draft_message_id: draft?.id,
        edited_body: body,
        mark_as_resolved: markResolved,
      });
      setBody('');
      setTouched(false);
      onSent();
    } catch (e: any) {
      toast.error(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }

  if (readonly) {
    return (
      <div className="border-t border-butter-300/60 bg-butter-50 px-5 py-4 text-sm">
        <div className="section-label mb-2">Reply · read-only · driven elsewhere</div>
        <div className="prose-msg"><ReactMarkdown>{body || '(empty)'}</ReactMarkdown></div>
      </div>
    );
  }

  const hasDraft = !!body.trim();
  const summary = draft
    ? 'AI draft loaded — edit before sending'
    : hasDraft
      ? `${body.trim().slice(0, 60)}${body.trim().length > 60 ? '…' : ''}`
      : 'Type your reply…';

  return (
    <div className="border-t border-butter-300/60 bg-gradient-to-b from-caramel/[0.05] to-transparent">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-caramel/[0.04] transition-colors"
        aria-expanded={!collapsed}
        aria-controls="draft-reply-body"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="section-label shrink-0">Reply</div>
          {collapsed && (
            <div className="text-xs text-muted-foreground truncate">{summary}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </div>
      </button>
      {!collapsed && (
        <div id="draft-reply-body" className="px-5 pb-4 space-y-3">
          {draft && (
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-caramel/80">
              AI draft loaded — edit before sending
            </div>
          )}
          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="edit">
              <Textarea
                value={body}
                onChange={(e) => { setBody(e.target.value); setTouched(true); }}
                rows={6}
                placeholder="Type your reply…"
              />
            </TabsContent>
            <TabsContent value="preview">
              <div className="prose-msg rounded-xl border border-rule-soft bg-paper-warm p-4 text-sm min-h-[140px]">
                <ReactMarkdown>{body}</ReactMarkdown>
              </div>
            </TabsContent>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={() => send(true)} disabled={sending || !body.trim()}>
              {sending ? 'Sending…' : 'Send + resolve'}
            </Button>
            <Button size="sm" variant="crust" onClick={() => send(false)} disabled={sending || !body.trim()}>
              {sending ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
