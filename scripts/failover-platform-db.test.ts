import { describe, it, expect } from 'vitest';
import { parseArgs } from './failover-platform-db.js';

describe('failover-platform-db argument parsing', () => {
  it('parses the status subcommand', () => {
    expect(parseArgs(['status'])).toEqual({ subcommand: 'status', yes: false });
  });

  it('parses the promote subcommand', () => {
    expect(parseArgs(['promote'])).toEqual({ subcommand: 'promote', yes: false });
  });

  it('parses --yes flag', () => {
    expect(parseArgs(['promote', '--yes'])).toEqual({ subcommand: 'promote', yes: true });
  });

  it('parses the failback subcommand', () => {
    expect(parseArgs(['failback'])).toEqual({ subcommand: 'failback', yes: false });
  });

  it('throws on unknown subcommand', () => {
    expect(() => parseArgs(['delete-everything'])).toThrow(/unknown subcommand/i);
  });

  it('throws when no subcommand is provided', () => {
    expect(() => parseArgs([])).toThrow(/subcommand required/i);
  });
});
