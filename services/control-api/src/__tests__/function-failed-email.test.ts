// Snapshot the function_failed billing-email subject + body across the four
// threshold tiers (1, 10, 100, 1000). These are user-facing strings — the
// snapshot is the spec. If the wording changes, update the snapshot and
// review the diff against the UX intent: the subject must surface app +
// function + count, and the body must lead with the logs link, not bury it.
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
  for (const tier of ['1', '10', '100', '1000']) {
    it(`subject at tier ${tier} surfaces app, function, count`, () => {
      const subject = buildBillingEmailSubject('function_failed', {
        ...baseData,
        thresholdTier: tier,
        errorCount: tier,
      });
      expect(subject).toMatchSnapshot();
      // Hard invariants — if any of these regress, the inbox becomes useless:
      expect(subject).toContain('pantry');
      expect(subject).toContain('capture-lead');
      expect(subject).toContain(tier);
    });

    it(`body at tier ${tier} leads with logs link and reframes the tier note`, () => {
      const body = buildBillingEmailBody('function_failed', {
        ...baseData,
        thresholdTier: tier,
        errorCount: tier,
      });
      expect(body).toMatchSnapshot();
      // Logs link must come BEFORE the threshold-tier disclaimer.
      const logsIdx = body.indexOf('Open logs:');
      const tierIdx = body.search(/We'll only email again|This is the highest/);
      expect(logsIdx).toBeGreaterThan(-1);
      expect(tierIdx).toBeGreaterThan(logsIdx);
    });
  }

  it('truncates very long error messages to 500 chars + ellipsis', () => {
    const huge = 'X'.repeat(2000);
    const body = buildBillingEmailBody('function_failed', {
      ...baseData,
      thresholdTier: '10',
      errorCount: '10',
      errorMessage: huge,
    });
    expect(body).toContain('X'.repeat(500) + '…');
    expect(body).not.toContain('X'.repeat(501));
  });

  it('falls back gracefully when error message is missing', () => {
    const body = buildBillingEmailBody('function_failed', {
      ...baseData,
      thresholdTier: '1',
      errorCount: '1',
      errorMessage: '',
    });
    expect(body).toContain('(no message captured)');
  });

  it('falls back to appId when appName is missing (still uses bracket prefix)', () => {
    const subject = buildBillingEmailSubject('function_failed', {
      ...baseData,
      appName: '',
      thresholdTier: '1',
      errorCount: '1',
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
      thresholdTier: '10',
      errorCount: '10',
    });
    expect(html).not.toBeNull();
    expect(html).toMatchSnapshot();
  });

  it('renders a final-tier message at 1000 without "next email" copy', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      thresholdTier: '1000',
      errorCount: '1000',
    })!;
    expect(html).toContain('highest alert tier');
    expect(html).not.toMatch(/We'll only email again/);
  });

  it('escapes HTML in user-controlled fields (XSS guard)', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      appName: '<script>alert(1)</script>',
      functionName: 'fn"&<>',
      errorMessage: 'Error: </pre><img src=x onerror=alert(1)>',
      thresholdTier: '1',
      errorCount: '1',
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
    const data = { ...baseData, thresholdTier: '10', errorCount: '10' };
    const html = buildBillingEmailHtml('function_failed', data)!;
    const text = buildBillingEmailBody('function_failed', data);
    const textUrl = text.match(/https:\/\/[^\s]+/)![0];
    expect(html).toContain(`href="${textUrl}"`);
  });

  it('includes the Butterbase wordmark with alt-text fallback', () => {
    const html = buildBillingEmailHtml('function_failed', {
      ...baseData,
      thresholdTier: '1',
      errorCount: '1',
    })!;
    expect(html).toMatch(/<img src="https:\/\/[^"]+\/logo-white\.png" alt="Butterbase"/);
    // Image-blocked clients show alt text — must be styled to render on the
    // dark header (white text). If this regresses, blocked images render
    // black-on-black and disappear.
    expect(html).toMatch(/alt="Butterbase"[^>]*color:#ffffff/);
  });
});
