import * as React from 'react';
import { cn } from '@/console/lib/utils';
import { X } from 'lucide-react';

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-foreground/30 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative z-10 animate-rise">{children}</div>
    </div>
  );
}

export function DialogContent({
  className,
  children,
  onClose,
}: {
  className?: string;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        'relative w-[520px] max-w-[92vw] rounded-lg border border-border bg-background p-6 shadow-lg',
        className,
      )}
    >
      {onClose && (
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground opacity-70 hover:opacity-100 hover:bg-muted transition-opacity"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {children}
    </div>
  );
}

export const DialogHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-5">{children}</div>
);
export const DialogTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="font-display text-[22px] tracking-tight text-foreground">{children}</h2>
);
export const DialogDescription = ({ children }: { children: React.ReactNode }) => (
  <p className="font-editorial italic text-[14px] text-muted-foreground mt-1.5 leading-relaxed">{children}</p>
);
