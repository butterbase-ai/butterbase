import { ChevronLeft, CheckCircle2, PlusCircle } from 'lucide-react';
import { MessageThread } from './MessageThread';
import { MessageComposer } from './MessageComposer';
import { CitationFooter } from './CitationFooter';
import { BrandMark } from './BrandMark';
import type { WidgetMessage } from '../lib';

export function WidgetPanel({
  messages,
  onSend,
  onBack,
  error,
  loading,
  aiTyping,
  ticketStatus,
  onStartNew,
}: {
  messages: WidgetMessage[];
  onSend: (body: string) => Promise<void>;
  onBack?: () => void;
  error: string | null;
  loading: boolean;
  aiTyping?: boolean;
  ticketStatus?: string | null;
  onStartNew?: () => void;
}) {
  const resolved = ticketStatus === 'resolved';
  return (
    <div className="bs-shadow bs-grain flex h-[580px] w-[388px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-3xl bg-[#FAF6EC]">
      {/* Header — warm butter band on cocoa text */}
      <div
        className="relative px-4 pt-4 pb-5"
        style={{
          background:
            'linear-gradient(180deg, #FBE08E 0%, #F5C842 70%, #E8B22A 100%)',
          color: '#2A1C0A',
        }}
      >
        <div
          className="absolute inset-0 opacity-20 pointer-events-none"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 0%, rgba(255,255,255,0.5), transparent 40%), radial-gradient(circle at 80% 100%, rgba(232,132,60,0.25), transparent 50%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-full p-1 hover:bg-black/10 transition-colors"
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <BrandMark size={32} />
          <div className="flex-1 min-w-0">
            <div className="bs-display text-[17px] font-semibold leading-tight tracking-tight">Hey there 👋</div>
            <div className="text-[11px] opacity-70 mt-0.5 flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 rounded-full bg-[#0F8A4A] animate-pulse" />
              </span>
              Usually replies in a few minutes
            </div>
          </div>
          {onStartNew && messages.length > 0 && !resolved && (
            <button
              type="button"
              onClick={onStartNew}
              className="rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-[#2A1C0A] hover:bg-white transition-colors inline-flex items-center gap-1"
              aria-label="Start a new conversation"
              title="Start a new conversation"
            >
              <PlusCircle className="h-3 w-3" strokeWidth={2.25} />
              New
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-y border-[#E8843C]/30 bg-[#FBE7DC] px-4 py-2 text-xs text-[#8A3A12]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[#9C8E7A]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#F5C842] animate-pulse" />
          loading…
        </div>
      ) : (
        <MessageThread messages={messages} aiTyping={aiTyping} />
      )}

      {resolved && (
        <div className="border-t border-[#0F8A4A]/25 bg-[#E7F4EC] px-4 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-[#0F5C32]">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            This conversation is resolved
          </div>
          <button
            type="button"
            onClick={onStartNew}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#0F8A4A]/40 bg-white px-3 py-1.5 text-[11px] font-semibold text-[#0F5C32] hover:bg-[#0F8A4A] hover:text-white transition-colors"
          >
            <PlusCircle className="h-3 w-3" strokeWidth={2.25} />
            Start a new conversation
          </button>
        </div>
      )}

      {!resolved && <MessageComposer onSend={onSend} disabled={loading} />}
      <CitationFooter />
    </div>
  );
}
