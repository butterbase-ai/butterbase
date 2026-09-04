import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  question: string;
  options?: { label: string; value: string }[];
  allow_free_text?: boolean;
  onSubmit: (text: string) => void;
}

export function AskUserCard({ question, options, allow_free_text, onSubmit }: Props) {
  const [text, setText] = useState('');
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <p className="text-[13.5px] font-medium">{question}</p>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <Button key={o.value} variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => onSubmit(o.label)}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {allow_free_text !== false && (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSubmit(text); setText(''); } }} className="flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Or type a reply…"
            className="flex-1 h-8 rounded-md border border-input bg-transparent px-2 text-[12.5px]"
          />
          <Button type="submit" size="sm" className="h-8" disabled={!text.trim()}>Send</Button>
        </form>
      )}
    </div>
  );
}
