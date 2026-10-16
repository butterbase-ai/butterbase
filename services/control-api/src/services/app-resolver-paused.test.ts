import { describe, it, expect } from 'vitest';
import { AppPausedError, assertAppNotPaused, pausedRemediation } from './app-resolver.js';

describe('pausedRemediation', () => {
  it('keeps the owner copy, with and without a reason', () => {
    expect(pausedRemediation('owner', 'incident')).toBe(
      'The app owner paused this app: "incident". Wait for it to be resumed, or contact the owner.',
    );
    expect(pausedRemediation('owner', null)).toBe(
      'The app owner paused this app. Wait for it to be resumed, or contact the owner.',
    );
  });

  it('treats a NULL paused_by (pre-056 rows) as an owner pause', () => {
    expect(pausedRemediation(null, null)).toBe(pausedRemediation('owner', null));
  });

  it('explains an idle pause without blaming the owner', () => {
    const idle = 'This app was paused after a period without activity. The owner can upgrade to a paid plan to resume it.';
    expect(pausedRemediation('idle_reaper', 'Paused after 28 days without activity.')).toBe(idle);
    const staging = 'This app was paused after a period without activity. The owner can resume it from the Butterbase dashboard.';
    expect(pausedRemediation('staging_reaper', 'Automatically paused after 7 days of inactivity.')).toBe(staging);
    expect(pausedRemediation('staging_reaper', null)).toBe(staging);
  });

  it('keeps admin pauses neutral', () => {
    expect(pausedRemediation('admin', 'abuse report')).toBe('This app is paused. Contact the app owner.');
  });
});

describe('assertAppNotPaused', () => {
  it('carries paused_by onto the error', () => {
    try {
      assertAppNotPaused({ id: 'app_1', paused: true, paused_reason: 'x', paused_by: 'idle_reaper' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppPausedError);
      expect((err as AppPausedError).pausedBy).toBe('idle_reaper');
      expect((err as AppPausedError).reason).toBe('x');
    }
  });

  it('does nothing for a running app', () => {
    expect(() => assertAppNotPaused({ id: 'app_1', paused: false })).not.toThrow();
  });
});
