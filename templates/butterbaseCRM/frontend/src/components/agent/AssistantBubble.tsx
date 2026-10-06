export function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-lg bg-card border border-border px-3 py-2 text-[13.5px] whitespace-pre-wrap leading-relaxed">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-3 w-1 align-text-bottom bg-foreground/40 animate-pulse" />}
      </div>
    </div>
  );
}
