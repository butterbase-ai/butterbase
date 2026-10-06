import * as React from 'react';
import { create } from 'zustand';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';
import { cn } from '@/console/lib/utils';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title?: string;
  description: string;
  durationMs: number;
  leaving?: boolean;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'leaving'>) => string;
  requestDismiss: (id: string) => void;
  remove: (id: string) => void;
}

const DEFAULT_DURATION_MS = 4500;
const EXIT_DURATION_MS = 180;
let counter = 0;
const nextId = () => `t_${Date.now().toString(36)}_${(counter++).toString(36)}`;

const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId();
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    if (t.durationMs > 0) {
      setTimeout(() => get().requestDismiss(id), t.durationMs);
    }
    return id;
  },
  requestDismiss: (id) => {
    const target = get().toasts.find((x) => x.id === id);
    if (!target || target.leaving) return;
    set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
    setTimeout(() => get().remove(id), EXIT_DURATION_MS);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

interface ShortOpts {
  title?: string;
  durationMs?: number;
}

function emit(variant: ToastVariant, description: string, opts: ShortOpts = {}) {
  return useToastStore.getState().push({
    variant,
    description,
    title: opts.title,
    durationMs: opts.durationMs ?? DEFAULT_DURATION_MS,
  });
}

export const toast = {
  success: (description: string, opts?: ShortOpts) => emit('success', description, opts),
  error: (description: string, opts?: ShortOpts) => emit('error', description, opts),
  info: (description: string, opts?: ShortOpts) => emit('info', description, opts),
  warning: (description: string, opts?: ShortOpts) => emit('warning', description, opts),
  dismiss: (id: string) => useToastStore.getState().requestDismiss(id),
};

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const ACCENT: Record<ToastVariant, string> = {
  success: 'text-emerald-500',
  error: 'text-destructive',
  warning: 'text-butter',
  info: 'text-primary',
};

function ToastCard({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const Icon = ICONS[t.variant];
  return (
    <div
      role="status"
      aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-auto flex w-[360px] max-w-[92vw] gap-3 rounded-lg border border-border bg-background p-4 shadow-lg',
        t.leaving ? 'animate-toast-out' : 'animate-toast-in',
      )}
    >
      <Icon className={cn('mt-[2px] h-5 w-5 shrink-0', ACCENT[t.variant])} />
      <div className="flex-1 min-w-0">
        {t.title ? (
          <p className="text-sm font-medium text-foreground leading-tight">{t.title}</p>
        ) : null}
        <p
          className={cn(
            'text-sm text-muted-foreground leading-snug break-words',
            t.title ? 'mt-1' : '',
          )}
        >
          {t.description}
        </p>
      </div>
      <button
        aria-label="Dismiss notification"
        onClick={onClose}
        className="self-start rounded-sm p-1 text-muted-foreground opacity-60 hover:opacity-100 hover:bg-muted transition-opacity"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const requestDismiss = useToastStore((s) => s.requestDismiss);
  return (
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} t={t} onClose={() => requestDismiss(t.id)} />
      ))}
    </div>
  );
}
