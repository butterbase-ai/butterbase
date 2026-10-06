import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Loader2,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  AlertTriangle,
  RotateCw,
  CheckCircle2,
  Flag,
  Lightbulb,
  X,
} from 'lucide-react';
import {
  useMeetingNotes,
  useStartNotetaker,
  useCancelNotetaker,
  useIngestMeetingTranscript,
  type NotetakerStatus,
} from '@/hooks/useMeetingNotes';

interface Props {
  meetingId: string;
}

export function MeetingNotetakerPanel({ meetingId }: Props) {
  const notesQ = useMeetingNotes(meetingId);
  const startBot = useStartNotetaker();
  const cancelBot = useCancelNotetaker();
  const ingest = useIngestMeetingTranscript();

  const [retryNonce, setRetryNonce] = useState(0); // forces back-to-idle UI after failure
  const data = notesQ.data;
  const rawStatus = (data?.status ?? 'idle') as NotetakerStatus;
  // Local "retry" override — bumps us back to idle UI without mutating server state.
  const status: NotetakerStatus = retryNonce > 0 && rawStatus === 'failed' ? 'idle' : rawStatus;

  if (notesQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-20" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="eyebrow">Notetaker</p>
        <StatusPill status={status} />
      </div>

      {status === 'idle' && (
        <IdleState
          meetingId={meetingId}
          onStart={() =>
            startBot.mutate(meetingId, {
              onSuccess: () => toast.success('Notetaker dispatched'),
              onError: (e) =>
                toast.error(e instanceof Error ? e.message : 'Could not start notetaker'),
            })
          }
          starting={startBot.isPending}
          onIngest={(text) =>
            ingest.mutate(
              { meeting_id: meetingId, transcript_text: text },
              {
                onSuccess: () => toast.success('Transcript saved'),
                onError: (e) =>
                  toast.error(e instanceof Error ? e.message : 'Could not save transcript'),
              },
            )
          }
          ingesting={ingest.isPending}
        />
      )}

      {status === 'pending_transcript' && (
        <PendingState
          meetingId={meetingId}
          onIngest={(text) =>
            ingest.mutate(
              { meeting_id: meetingId, transcript_text: text },
              {
                onSuccess: () => toast.success('Transcript saved'),
                onError: (e) =>
                  toast.error(e instanceof Error ? e.message : 'Could not save transcript'),
              },
            )
          }
          ingesting={ingest.isPending}
          onCancel={() =>
            cancelBot.mutate(meetingId, {
              onSuccess: () => toast.success('Notetaker cancelled'),
              onError: (e) =>
                toast.error(e instanceof Error ? e.message : 'Could not cancel notetaker'),
            })
          }
          cancelling={cancelBot.isPending}
        />
      )}

      {status === 'done' && <DoneState data={data!} />}

      {status === 'failed' && (
        <FailedState
          error={data?.error ?? null}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── status pill ─────────────────────────── */

function StatusPill({ status }: { status: NotetakerStatus }) {
  if (status === 'done')
    return <span className="stage-pill !bg-sage/15 !text-sage">ready</span>;
  if (status === 'pending_transcript')
    return <span className="stage-pill !bg-butter/15 !text-butter">en route</span>;
  if (status === 'failed')
    return <span className="stage-pill !bg-coral/15 !text-coral">failed</span>;
  return <span className="stage-pill">not started</span>;
}

/* ─────────────────────────── manual paste affordance ─────────────────────────── */

function PasteAffordance({
  onIngest,
  ingesting,
  defaultOpen = false,
}: {
  onIngest: (text: string) => void;
  ingesting: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');

  return (
    <div className="card-flat p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[12.5px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Paste transcript manually
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full meeting transcript here…"
            rows={6}
            className="bg-background text-[13px]"
          />
          <div className="flex items-center justify-between">
            <p className="font-editorial italic text-[12px] text-muted-foreground">
              Notetaker bot is in beta — manual paste also works for testing.
            </p>
            <Button
              size="sm"
              onClick={() => {
                if (text.trim().length < 10) {
                  toast.error('Transcript looks too short.');
                  return;
                }
                onIngest(text);
                setText('');
                setOpen(false);
              }}
              disabled={ingesting || text.trim().length === 0}
              className="gap-1.5 bg-foreground text-background hover:bg-foreground/85"
            >
              {ingesting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <FileText className="h-3 w-3" />
              )}
              Save transcript
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── states ─────────────────────────── */

function IdleState({
  onStart,
  starting,
  onIngest,
  ingesting,
}: {
  meetingId: string;
  onStart: () => void;
  starting: boolean;
  onIngest: (text: string) => void;
  ingesting: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="card-flat p-4 flex items-center gap-4">
        <div className="grid place-items-center h-10 w-10 rounded-md bg-background border border-border shrink-0">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] text-foreground leading-tight">Send a notetaker to this meeting</p>
          <p className="mt-1 font-editorial italic text-[12.5px] text-muted-foreground">
            The bot will join, transcribe, and post decisions, commitments, and learnings back here.
          </p>
        </div>
        <Button
          onClick={onStart}
          disabled={starting}
          className="gap-2 bg-foreground text-background hover:bg-foreground/85"
        >
          {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
          Send notetaker
        </Button>
      </div>
      <PasteAffordance onIngest={onIngest} ingesting={ingesting} />
    </div>
  );
}

function PendingState({
  onIngest,
  ingesting,
  onCancel,
  cancelling,
}: {
  meetingId: string;
  onIngest: (text: string) => void;
  ingesting: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="card-flat p-4 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-butter shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] text-foreground">Notetaker en route…</p>
          <p className="font-editorial italic text-[12.5px] text-muted-foreground mt-0.5">
            We’ll show the transcript and structured takeaways as soon as the bot delivers. Stuck? Cancel and try again.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={cancelling}
          className="gap-1.5 shrink-0"
        >
          {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Cancel
        </Button>
      </div>
      <PasteAffordance onIngest={onIngest} ingesting={ingesting} defaultOpen={false} />
    </div>
  );
}

function DoneState({ data }: { data: { artifact?: any; decisions?: any[]; commitments?: any[]; learnings?: any[] } }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const artifact = data.artifact ?? {};
  const content: string = artifact.content ?? '';
  const summary: string | null = artifact.summary ?? null;
  const decisions = data.decisions ?? [];
  const commitments = data.commitments ?? [];
  const learnings = data.learnings ?? [];

  return (
    <div className="space-y-4">
      {/* Summary */}
      {summary && (
        <div className="card-flat p-4">
          <p className="eyebrow mb-2">Summary</p>
          <p className="text-[13.5px] text-foreground leading-relaxed">{summary}</p>
        </div>
      )}

      {/* Transcript collapsible */}
      <div className="card-flat p-4">
        <button
          type="button"
          onClick={() => setShowTranscript((s) => !s)}
          className="flex items-center gap-2 text-[12.5px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showTranscript ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Transcript {content ? `· ${content.length.toLocaleString()} chars` : ''}
        </button>
        {showTranscript && (
          <div className="mt-3 max-h-80 overflow-y-auto">
            {content ? (
              <p className="text-[13px] text-foreground/90 leading-relaxed whitespace-pre-wrap font-mono">
                {content}
              </p>
            ) : (
              <p className="font-editorial italic text-[12.5px] text-muted-foreground">
                Transcript is empty.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Three structured sections */}
      <TakeawaySection
        eyebrow="Decisions"
        icon={<CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />}
        items={decisions}
      />
      <TakeawaySection
        eyebrow="Commitments"
        icon={<Flag className="h-3.5 w-3.5 text-muted-foreground" />}
        items={commitments}
      />
      <TakeawaySection
        eyebrow="Learnings"
        icon={<Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />}
        items={learnings}
      />
    </div>
  );
}

function TakeawaySection({
  eyebrow,
  icon,
  items,
}: {
  eyebrow: string;
  icon: React.ReactNode;
  items: Array<{ text: string; [k: string]: any }>;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="eyebrow">{eyebrow}</p>
      </div>
      {items.length === 0 ? (
        <p className="font-editorial italic text-[13px] text-muted-foreground pl-5">—</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="card-flat p-3 flex items-start gap-2">
              <span className="font-mono text-[10px] text-muted-foreground mt-1 num">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-[13px] text-foreground leading-relaxed">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FailedState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="card-flat p-4 border border-coral/40 bg-coral/5 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-coral mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] text-foreground">Notetaker failed</p>
          <p className="mt-1 font-editorial italic text-[12.5px] text-muted-foreground">
            {error ?? 'Something went wrong delivering the transcript. You can try again or paste it manually.'}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RotateCw className="h-3 w-3" />
          Try again
        </Button>
      </div>
    </div>
  );
}
