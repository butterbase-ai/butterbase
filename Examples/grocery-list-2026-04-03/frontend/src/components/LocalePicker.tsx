import { useEffect } from 'react';
import { useLocale, text } from '../i18n';
import { setLocale } from '../i18n-core.mjs';
export function LocalePicker({ title }: { title: string }) {
  const locale = useLocale();
  useEffect(() => { document.documentElement.lang = locale; document.title = text(title); }, [locale, title]);
  return <div className="example-language"><label>{text('Display language')}{' '}
    <select value={locale} onChange={event => setLocale(event.target.value)}>
      <option value="en" lang="en">English</option><option value="ja" lang="ja">日本語</option>
    </select></label></div>;
}
