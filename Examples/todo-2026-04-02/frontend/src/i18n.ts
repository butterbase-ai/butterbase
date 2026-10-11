import { useSyncExternalStore, createElement, type ReactNode } from 'react';
import { getLocale, subscribe, text, UiError } from './i18n-core.mjs';
export { text, formatDate, UiError } from './i18n-core.mjs';
export function useLocale() { return useSyncExternalStore(subscribe, getLocale, () => 'en' as const); }
function LocalizedText({ source }: { source: string }) { useLocale(); return text(source); }
export function localizedMessage(source: string): ReactNode { return createElement(LocalizedText, { source }); }
export function errorMessage(error: unknown, fallback: string): ReactNode {
  if (error instanceof UiError) return localizedMessage(error.message);
  const message = error && typeof error === 'object' && 'message' in error ? error.message : null;
  return typeof message === 'string' && message ? message : localizedMessage(fallback);
}
