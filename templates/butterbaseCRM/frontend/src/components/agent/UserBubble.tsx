export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-foreground/[0.06] px-3 py-2 text-[13.5px] whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}
