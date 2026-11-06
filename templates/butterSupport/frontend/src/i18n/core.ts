import { japaneseMessages } from './ja';
export type UiLocale = 'en' | 'ja';
export const languageStorageKey = "butterbase-support-language";
function readLocale(): UiLocale {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(languageStorageKey) === 'ja' ? 'ja' : 'en'; }
  catch { return 'en'; }
}
let locale: UiLocale = readLocale();
const listeners = new Set<() => void>();
export function getUiLocale(): UiLocale { return locale; }
export function setUiLocale(next: UiLocale): void {
  if (next !== 'en' && next !== 'ja') return;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(languageStorageKey, next); } catch { /* Storage may be unavailable in an embed. */ }
  if (next === locale) return;
  locale = next;
  listeners.forEach(listener => listener());
}
export function initializeUiLocale(next: UiLocale): void {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(languageStorageKey) : null;
    if (saved === 'en' || saved === 'ja') return;
  } catch { /* An embed may block storage; its initial language can still work. */ }
  setUiLocale(next);
}
function storageChanged(event: StorageEvent): void {
  if (event.key !== languageStorageKey) return;
  const next = event.newValue === 'ja' ? 'ja' : 'en';
  if (next === locale) return;
  locale = next;
  listeners.forEach(listener => listener());
}
export function subscribeUiLocale(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', storageChanged);
  };
}
export function uiText(source: string, translationKey = source): string {
  const key = translationKey.trim();
  return locale === 'ja' && Object.prototype.hasOwnProperty.call(japaneseMessages, key) ? japaneseMessages[key] : source;
}
export function uiMessage(strings: TemplateStringsArray, ...values: unknown[]): string {
  const key = strings.reduce((result, part, index) => result + (index ? '\$' + '{' + (index - 1) + '}' : '') + part, '');
  return uiText(key).replace(/\$\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));
}
