import { format as originalFormat, formatDistanceToNow as originalDistance, formatDistanceToNowStrict as originalStrict } from 'date-fns';
import { ja } from 'date-fns/locale';
import { getUiLocale } from './core';
export function format(...args: Parameters<typeof originalFormat>): string {
  return originalFormat(args[0], args[1], { ...args[2], ...(getUiLocale() === 'ja' ? { locale: ja } : {}) });
}
export function formatDistanceToNow(...args: Parameters<typeof originalDistance>): string {
  return originalDistance(args[0], { ...args[1], ...(getUiLocale() === 'ja' ? { locale: ja } : {}) });
}
export function formatDistanceToNowStrict(...args: Parameters<typeof originalStrict>): string {
  return originalStrict(args[0], { ...args[1], ...(getUiLocale() === 'ja' ? { locale: ja } : {}) });
}
