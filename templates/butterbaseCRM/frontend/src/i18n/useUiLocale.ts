import { useSyncExternalStore } from 'react';
import { getUiLocale, subscribeUiLocale } from './core';

export function useUiLocale() {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, () => 'en' as const);
}
