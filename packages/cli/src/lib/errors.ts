import { msg } from './i18n.js';
import chalk from 'chalk';
import { ButterbaseError } from '@butterbase/sdk';

/**
 * Pretty-print a caught error for the CLI's top-level handler.
 * - Typed ButterbaseError: shows class name, message, code, status, remediation.
 * - Plain Error: just the message.
 * - Anything else: stringified.
 */
export function renderError(e: unknown): string {
  if (e instanceof ButterbaseError) {
    const lines = [chalk.red(`${e.name}: ${e.message}`)];
    if (e.code)        lines.push(chalk.gray(msg`  code:        ${e.code}`));
    if (e.status)      lines.push(chalk.gray(msg`  status:      ${e.status}`));
    if (e.remediation) lines.push(chalk.yellow(msg`  remediation: ${e.remediation}`));
    return lines.join('\n');
  }
  if (e instanceof Error) return chalk.red(e.message);
  return chalk.red(String(e));
}
