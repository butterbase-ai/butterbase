// Snapshot the function_failed billing-email subject + body for the
// streak-based notification model. These are user-facing strings — the
// snapshot is the spec. If the wording changes, update the snapshot and
// review the diff against the UX intent: the subject must surface app +
// function + streak length, and the body must lead with the logs link,
// not bury it.
import { describe, it, expect } from 'vitest';
import {
  buildBillingEmailSubject,
  buildBillingEmailBody,
  buildBillingEmailHtml,
} from '../services/auth/email-service.js';

const baseData = {
  appId: 'app_test001',
  appName: 'pantry',
  functionName: 'capture-lead',
  functionId: 'fn_abc123',
  errorMessage: 'TypeError: Cannot read properties of undefined (reading \'rows\')',
};

describe('function_failed email', () => {
  for (const streak of ['3', '7']) {
    it(`subject at streak ${streak} surfaces app, function, streak length`, () => {
      const subject = buildBillingEmailSubject('function_failed', {
        ...baseData,
        streakLen: streak,
      });
      expect(subject).toMatchSnapshot();
      // Hard invariants — if any of these regress, the inbox becomes useless:
      expect(subject).toContain('pantry');
      expect(subject).toContain('capture-lead');
      expect(subject).toContain(streak);
    });

    it(`body at streak ${streak} leads with logs link and trails with re-arm note`, () => {
      const body = buildBillingEmailBody('function_failed', {
        ...baseData,
        streakLen: streak,
      });
      expect(body).toMatchSnapshot();
      // Logs link must come BEFORE the re-arm disclaimer.
      const logsIdx = body.indexOf('Open logs:');
      const reArmIdx = body.indexOf("We'll only email again");
      expect(logsIdx).toBeGreaterThan(-1);
      expect(reArmIdx).toBeGreaterThan(logsIdx);
    });
  }

  it('truncates very long error messages to 500 chars + ellipsis', () => {
    const huge = 'X'.repeat(2000);
    const body = buildBillingEmailBody('function_failed', {
      ...baseData,
      streakLen: '3',
      errorMessage: huge,
    });
    expect(body).toContain('X'.repeat(500) + '…');
    expect(body).not.toContain('X'.repeat(501));
  });

  it('falls back gracefully when error message is missing', () => {
    const body = buildBillingEmailBody('function_failed', {
      ...baseData,
      streakLen: '3',
      errorMessage: '',
    });
    expect(body).toContain('(no message captured)');
  });

  it('falls back to appId when appName is missing (still uses bracket prefix)', () => {
    const subject = buildBillingEmailSubject('function_failed', {
      ...baseData,
      appName: '',
      streakLen: '3',
    });
    expect(subject).toContain('[app_test001]');
  });

  it('other templates still use the static subject map', () => {
    expect(buildBillingEmailSubject('payment_failed', {})).toBe('Action Required: Payment Failed');
    expect(buildBillingEmailSubject('deployment_failed', {})).toBe('Deployment failed');
  });
});

describe('function_failed HTML body', () => {
  it('renders an HTML variant alongside the text body', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      streakLen: '3',
    });
    expect(html).not.toBeNull();
    expect(html).toMatchSnapshot();
  });

  it('renders the re-arm note in the HTML variant', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      streakLen: '5',
    })!;
    expect(html).toContain('only email again after a successful run');
  });

  it('escapes HTML in user-controlled fields (XSS guard)', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      appName: '<script>alert(1)</script>',
      functionName: 'fn"&<>',
      errorMessage: 'Error: </pre><img src=x onerror=alert(1)>',
      streakLen: '3',
    })!;
    // None of the dangerous strings survive as live HTML.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('</pre><img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    // The function name with quotes/ampersand is rendered, just escaped.
    expect(html).toContain('fn&quot;&amp;&lt;&gt;');
  });

  it('returns null for templates without an HTML variant (text-only fallback)', () => {
    expect(buildBillingEmailHtml('payment_failed', {})).toBeNull();
    expect(buildBillingEmailHtml('deployment_failed', {})).toBeNull();
    expect(buildBillingEmailHtml('auth_hook_failed', {})).toBeNull();
  });

  it('embeds the same logs URL the text body uses', () => {
    const data = { ...baseData, streakLen: '3' };
    const html = buildBillingEmailHtml('function_failed', data)!;
    const text = buildBillingEmailBody('function_failed', data);
    const textUrl = text.match(/https:\/\/[^\s]+/)![0];
    expect(html).toContain(`href="${textUrl}"`);
  });

  it('includes the Butterbase wordmark with alt-text fallback', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      streakLen: '3',
    })!;
    expect(html).toMatch(/<img src="https:\/\/[^"]+\/logo-white\.png" alt="Butterbase"/);
    // Image-blocked clients show alt text — must be styled to render on the
    // dark header (white text). If this regresses, blocked images render
    // black-on-black and disappear.
    expect(html).toMatch(/alt="Butterbase"[^>]*color:#ffffff/);
  });
});
