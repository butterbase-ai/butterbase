import { getCliLocale } from './i18n.js';

/** Commander diagnostics only. Backend messages and error codes stay verbatim. */
export function localizeCommanderError(output: string): string {
  if (getCliLocale() !== 'ja') return output;
  return output
    .replace(/^error: unknown option '([^']*)'/, "エラー：不明なオプション '$1'")
    .replace(/^error: unknown command '([^']*)'/, "エラー：不明なコマンド '$1'")
    .replace(/^error: missing required argument '([^']*)'/, "エラー：必須の引数 '$1' がありません")
    .replace(/^error: option '([^']*)' argument missing/, "エラー：オプション '$1' の値がありません")
    .replace(/^error: required option '([^']*)' not specified/, "エラー：必須のオプション '$1' がありません")
    .replace(/^error: option '([^']*)' argument '([^']*)' is invalid\. Allowed choices are (.*)\./, "エラー：オプション '$1' の値 '$2' は無効です。使える値：$3。")
    .replace(/^error: too many arguments(?: for '([^']*)')?\. Expected (\d+) arguments? but got (\d+)\./, (_, command, expected, actual) =>
      `エラー：${command ? "'" + command + "' の" : ''}引数が多すぎます。必要：${expected}件、入力：${actual}件。`)
    .replace(/\(Did you mean ([^\n]*)\)/g, '（候補：$1）')
    .replace(/\(Did you mean one of ([^\n]*)\)/g, '（候補：$1）')
    .replace(/^error: /, 'エラー：');
}
