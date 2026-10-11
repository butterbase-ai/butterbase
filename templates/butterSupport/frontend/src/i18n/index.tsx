import { useEffect, useSyncExternalStore } from 'react';
import { getUiLocale, setUiLocale, subscribeUiLocale } from './core';
export { uiText, uiMessage, getUiLocale, setUiLocale, initializeUiLocale } from './core';
export function useUiLocale() {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, () => 'en' as const);
}
export function LanguagePicker() {
  const locale = useUiLocale();
  return <label className="inline-flex shrink-0 items-center gap-1 text-xs">
    <span className="sr-only">Language / 言語</span>
    <select aria-label="Language / 言語" value={locale} onChange={event => setUiLocale(event.target.value === 'ja' ? 'ja' : 'en')}
      className="rounded border border-current/20 bg-transparent px-2 py-1 text-inherit">
      <option value="en">English</option><option value="ja">日本語</option>
    </select>
  </label>;
}

export function DocumentLanguage() {
  const locale = useUiLocale();
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return null;
}
