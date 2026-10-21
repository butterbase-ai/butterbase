export type Locale = 'en' | 'ja';
export const translations: Readonly<Record<string, string>>;
export function getLocale(): Locale;
export function subscribe(listener: () => void): () => void;
export function setLocale(value: string): void;
export function text(source: string): string;
export function formatDate(value: string): string;
export class UiError extends Error {}
