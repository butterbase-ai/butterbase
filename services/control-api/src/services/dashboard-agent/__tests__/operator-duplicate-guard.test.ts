/**
 * LAYER 1 of the re-proposal defence — the pure part.
 *
 * The operator now KEEPS WORKING while a decision is pending (see
 * operator-turn.ts). The failure mode that creates is an operator which wakes
 * every minute, re-proposes the same email, and buries the owner under sixty
 * identical rows by morning. A prompt instruction is not a defence against
 * that — the model only has to have one off turn. This module is the part that
 * refuses in code.
 *
 * These tests pin WHAT "equivalent" means, because that definition is the
 * whole of the guard's soundness: too narrow and the flood gets through, too
 * wide and the operator is blocked from doing genuinely different work.
 */
import { describe, it, expect } from 'vitest';

import {
  exactActionFingerprint,
  targetActionFingerprint,
  findDuplicatePendingCall,
  describePendingCall,
  VOLATILE_ARG_KEYS,
  type PendingGatedCall,
} from '../operator-duplicate-guard.js';

function pending(over: Partial<PendingGatedCall> = {}): PendingGatedCall {
  return {
    approvalId: 'appr-1',
    toolName: 'manage_integrations',
    toolArgs: { action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'bob@example.com', body: 'Hi Bob' },
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    ...over,
  };
}

describe('exact fingerprint — byte-identical re-proposal', () => {
  it('is stable across key insertion order', () => {
    expect(exactActionFingerprint('t', { a: 1, b: 2 })).toBe(exactActionFingerprint('t', { b: 2, a: 1 }));
  });

  it('is stable across NESTED key insertion order', () => {
    expect(exactActionFingerprint('t', { x: { a: 1, b: 2 } })).toBe(
      exactActionFingerprint('t', { x: { b: 2, a: 1 } }),
    );
  });

  it('separates two different tools carrying identical arguments', () => {
    expect(exactActionFingerprint('a', { id: 1 })).not.toBe(exactActionFingerprint('b', { id: 1 }));
  });

  it('separates two different argument values', () => {
    expect(exactActionFingerprint('t', { to: 'bob' })).not.toBe(exactActionFingerprint('t', { to: 'ann' }));
  });

  it('treats absent and empty args as the same thing', () => {
    expect(exactActionFingerprint('t', undefined)).toBe(exactActionFingerprint('t', {}));
    expect(exactActionFingerprint('t', null)).toBe(exactActionFingerprint('t', {}));
  });
});

describe('target fingerprint — same action, same target, reworded body', () => {
  it('ignores TOP-LEVEL free-text fields so a reworded body is still the same decision', () => {
    const a = targetActionFingerprint('manage_integrations', { to: 'bob@example.com', body: 'Hi Bob' });
    const b = targetActionFingerprint('manage_integrations', { to: 'bob@example.com', body: 'Hello Robert' });
    expect(a).toBe(b);
  });

  it('does NOT ignore the target itself — a different recipient is a different decision', () => {
    const a = targetActionFingerprint('manage_integrations', { to: 'bob@example.com', body: 'x' });
    const b = targetActionFingerprint('manage_integrations', { to: 'ann@example.com', body: 'x' });
    expect(a).not.toBe(b);
  });

  it('strips ONLY at the top level — a nested body still discriminates', () => {
    // Deliberate blast-radius bound: a tool whose real payload is nested (e.g.
    // manage_schema's `tables`) must not collapse to "same tool, same app" just
    // because some nested key happens to be called `description`.
    const a = targetActionFingerprint('manage_schema', { app_id: 'a1', tables: [{ name: 't', description: 'one' }] });
    const b = targetActionFingerprint('manage_schema', { app_id: 'a1', tables: [{ name: 't', description: 'two' }] });
    expect(a).not.toBe(b);
  });

  it('names the free-text keys it ignores, explicitly', () => {
    // The set is a policy decision, not an implementation detail: whatever is
    // in it can no longer distinguish two pending decisions.
    expect([...VOLATILE_ARG_KEYS].sort()).toEqual(
      ['body', 'content', 'description', 'html', 'message', 'notes', 'prompt', 'reason', 'subject', 'summary', 'text'].sort(),
    );
  });
});

describe('findDuplicatePendingCall', () => {
  it('returns null when nothing is pending', () => {
    expect(findDuplicatePendingCall([], 'manage_integrations', { to: 'bob' })).toBeNull();
  });

  it('matches a byte-identical re-proposal and reports WHY', () => {
    const p = pending();
    const hit = findDuplicatePendingCall([p], p.toolName, p.toolArgs);
    expect(hit).toEqual({ approvalId: 'appr-1', match: 'exact' });
  });

  it('matches a REWORDED re-proposal of the same action against the same target', () => {
    const p = pending();
    const hit = findDuplicatePendingCall([p], 'manage_integrations', {
      action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'bob@example.com', body: 'Completely different words',
    });
    expect(hit).toEqual({ approvalId: 'appr-1', match: 'target' });
  });

  it('does NOT match a genuinely different action — the guard must not wedge real work', () => {
    const p = pending();
    expect(
      findDuplicatePendingCall([p], 'manage_integrations', {
        action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'someone-else@example.com', body: 'Hi Bob',
      }),
    ).toBeNull();
  });

  it('does NOT match a different tool', () => {
    expect(findDuplicatePendingCall([pending()], 'manage_app', { action: 'delete' })).toBeNull();
  });

  it('refuses to collapse two no-argument calls to different tools', () => {
    const p = pending({ toolName: 'manage_app', toolArgs: {} });
    expect(findDuplicatePendingCall([p], 'manage_billing', {})).toBeNull();
    expect(findDuplicatePendingCall([p], 'manage_app', {})).toEqual({ approvalId: 'appr-1', match: 'exact' });
  });

  it('reports the FIRST (oldest) matching approval when several match', () => {
    const older = pending({ approvalId: 'appr-old' });
    const newer = pending({ approvalId: 'appr-new' });
    expect(findDuplicatePendingCall([older, newer], older.toolName, older.toolArgs)?.approvalId).toBe('appr-old');
  });
});

describe('describePendingCall — the one line the owner-facing prompt gets', () => {
  it('names the tool and stays short', () => {
    const line = describePendingCall(pending(), new Date('2026-08-08T04:00:00.000Z'));
    expect(line).toContain('manage_integrations');
    expect(line).toContain('appr-1');
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('says how long it has been waiting', () => {
    const line = describePendingCall(pending(), new Date('2026-08-08T04:00:00.000Z'));
    expect(line).toMatch(/4h/);
  });

  it('never emits a newline — one decision is one line', () => {
    const line = describePendingCall(
      pending({ toolArgs: { body: 'line one\nline two\nline three' } }),
      new Date('2026-08-08T00:01:00.000Z'),
    );
    expect(line).not.toContain('\n');
  });
});
