import { japaneseMessages } from './i18n/ja.js';

export type CliLocale = 'en' | 'ja';
let locale: CliLocale = 'en';

/** Called after Commander has resolved flags and the environment. */
export function setCliLocale(value: CliLocale): void {
  locale = value;
}

export function getCliLocale(): CliLocale {
  return locale;
}

/** Translate only static presentation copy, never response data or JSON. */
export function text(source: string): string {
  return locale === 'ja' ? japaneseMessages[source] ?? source : source;
}

/** Interpolate once, so an argument containing ${0} stays literal. */
export function msg(strings: TemplateStringsArray, ...values: unknown[]): string {
  const source = strings.reduce((out, part, index) => out + (index ? '${' + (index - 1) + '}' : '') + part, '');
  return text(source).replace(/\$\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));
}
