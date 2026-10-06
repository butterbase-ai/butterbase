import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './dialog';
import { Button } from './button';

interface ConfirmOptions {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let openConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

export function confirm(opts: ConfirmOptions | string): Promise<boolean> {
  const normalized: ConfirmOptions =
    typeof opts === 'string' ? { description: opts } : opts;
  if (!openConfirm) {
    if (typeof window !== 'undefined') {
      return Promise.resolve(window.confirm(normalized.description));
    }
    return Promise.resolve(false);
  }
  return openConfirm(normalized);
}

export function ConfirmHost() {
  const [state, setState] = React.useState<ConfirmState | null>(null);

  React.useEffect(() => {
    openConfirm = (opts) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve });
      });
    return () => {
      openConfirm = null;
    };
  }, []);

  const close = (ok: boolean) => {
    if (!state) return;
    state.resolve(ok);
    setState(null);
  };

  if (!state) return null;
  const confirmLabel = state.confirmLabel ?? 'Confirm';
  const cancelLabel = state.cancelLabel ?? 'Cancel';
  const variant = state.variant ?? 'default';

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) close(false); }}>
      <DialogContent onClose={() => close(false)}>
        <DialogHeader>
          <DialogTitle>{state.title ?? 'Are you sure?'}</DialogTitle>
          <DialogDescription>{state.description}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>{cancelLabel}</Button>
          <Button variant={variant} onClick={() => close(true)} autoFocus>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
