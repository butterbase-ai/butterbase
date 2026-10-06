import { useState } from 'react';
import { Send } from 'lucide-react';

export function MessageComposer({ onSend, disabled }: { onSend: (body: string) => Promise<void>; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[#2A1C0A]/[0.06] bg-[#F4ECDB] p-3">
      <div
        className="flex items-end gap-2 rounded-2xl border bg-white px-3 py-2 transition-all duration-200"
        style={{
          borderColor: focused ? 'rgba(245, 200, 66, 0.7)' : 'rgba(42, 28, 10, 0.08)',
          boxShadow: focused ? '0 0 0 3px rgba(245, 200, 66, 0.18)' : 'none',
        }}
      >
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Write a message…"
          className="flex-1 resize-none bg-transparent py-1 text-sm text-[#2A1C0A] placeholder:text-[#9C8E7A] outline-none"
          disabled={disabled || busy}
        />
        <button
          onClick={submit}
          disabled={disabled || busy || !text.trim()}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#2A1C0A] transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
          style={{
            background:
              text.trim() && !disabled && !busy
                ? 'linear-gradient(135deg, #F5C842 0%, #E0A82E 100%)'
                : '#E6DCC4',
            boxShadow:
              text.trim() && !disabled && !busy
                ? '0 4px 12px -2px rgba(245, 200, 66, 0.5), inset 0 1px 0 rgba(255,255,255,0.3)'
                : 'none',
          }}
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
