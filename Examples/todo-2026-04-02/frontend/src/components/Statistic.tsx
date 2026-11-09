import type { ReactNode } from 'react';
import { useLocale, text } from '../i18n';
export function Statistic({ label, value }: { label: string; value: ReactNode }) {
  const locale = useLocale();
  return locale === 'ja' ? <>{text(label)} <strong>{value}</strong></> : <><strong>{value}</strong> {text(label)}</>;
}
