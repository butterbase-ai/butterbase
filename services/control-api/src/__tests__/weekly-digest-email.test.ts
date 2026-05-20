// Snapshot the weekly_digest template across the three shapes that matter:
// empty (quiet week), single-item, multi-item. These snapshots are the spec
// — if you change wording, review the diff and confirm the intent matches.
import { describe, it, expect } from 'vitest';
import {
  buildBillingEmailSubject,
  buildBillingEmailBody,
  buildBillingEmailHtml,
} from '../services/auth/email-service.js';
import { isoWeekKey } from '../services/digest-notifier.js';

const items3 = [
  { appId: 'app_pantry', appName: 'pantry', functionName: 'capture-lead', failureCount: 47, lastError: 'TypeError: Cannot read properties of undefined (reading \'rows\')' },
  { appId: 'app_recipes', appName: 'recipes', functionName: 'index-docs', failureCount: 12, lastError: 'fetch failed: ECONNREFUSED' },
  { appId: 'app_voyp', appName: 'voyp-personal', functionName: 'transcribe', failureCount: 3, lastError: '' },
];

const deploys2 = [
  { appId: 'app_recipes', appName: 'recipes', kind: 'frontend' as const, failureCount: 5, lastError: 'Build failed: TS error in src/index.tsx:12' },
  { appId: 'app_pantry', appName: 'pantry', kind: 'edge-ssr' as const, failureCount: 2, lastError: 'Worker size exceeded 10MB' },
];

describe('weekly_digest subject', () => {
  it('plural form when multiple items (functions only)', () => {
    expect(buildBillingEmailSubject('weekly_digest', { itemsJson: JSON.stringify(items3) }))
      .toBe('Your weekly digest: 3 things need attention');
  });
  it('singular form when one item', () => {
    expect(buildBillingEmailSubject('weekly_digest', { itemsJson: JSON.stringify([items3[0]]) }))
      .toBe('Your weekly digest: 1 thing needs attention');
  });
  it('counts functions + deploys together in the subject total', () => {
    expect(buildBillingEmailSubject('weekly_digest', {
      itemsJson: JSON.stringify(items3),
      deployItemsJson: JSON.stringify(deploys2),
    })).toBe('Your weekly digest: 5 things need attention');
  });
  it('quiet-week subject when zero items', () => {
    expect(buildBillingEmailSubject('weekly_digest', { itemsJson: '[]', deployItemsJson: '[]' }))
      .toBe('Your weekly Butterbase digest');
  });
  it('quiet-week subject when fields are missing/garbage', () => {
    expect(buildBillingEmailSubject('weekly_digest', {})).toBe('Your weekly Butterbase digest');
    expect(buildBillingEmailSubject('weekly_digest', { itemsJson: 'not-json' }))
      .toBe('Your weekly Butterbase digest');
  });
});

describe('weekly_digest body (text)', () => {
  it('renders a list with logs URL per item', () => {
    const body = buildBillingEmailBody('weekly_digest', { itemsJson: JSON.stringify(items3) });
    expect(body).toContain('Functions (3)');
    expect(body).toContain('capture-lead');
    expect(body).toContain('47 failures');
    expect(body).toContain('https://dashboard.butterbase.ai/apps/app_pantry/functions/capture-lead/logs');
    expect(body).toMatchSnapshot();
  });
  it('renders both Functions and Deployments sections when both present', () => {
    const body = buildBillingEmailBody('weekly_digest', {
      itemsJson: JSON.stringify(items3),
      deployItemsJson: JSON.stringify(deploys2),
    });
    expect(body).toContain('Functions (3)');
    expect(body).toContain('Deployments (2)');
    expect(body).toContain('frontend');
    expect(body).toContain('edge-ssr');
    expect(body).toMatchSnapshot();
  });
  it('renders Deployments only when no function failures', () => {
    const body = buildBillingEmailBody('weekly_digest', {
      itemsJson: '[]',
      deployItemsJson: JSON.stringify(deploys2),
    });
    expect(body).not.toContain('Functions');
    expect(body).toContain('Deployments (2)');
  });
  it('renders quiet-week message when both sections empty', () => {
    const body = buildBillingEmailBody('weekly_digest', { itemsJson: '[]', deployItemsJson: '[]' });
    expect(body).toContain('Nothing failed');
    expect(body).toMatchSnapshot();
  });
});

describe('weekly_digest body (HTML)', () => {
  it('renders a styled list with logs links', () => {
    const html = buildBillingEmailHtml('weekly_digest', { itemsJson: JSON.stringify(items3) })!;
    expect(html).toContain('3 things need attention');
    expect(html).toContain('href="https://dashboard.butterbase.ai/apps/app_pantry/functions/capture-lead/logs"');
    expect(html).toMatchSnapshot();
  });
  it('renders a quiet-week card when empty', () => {
    const html = buildBillingEmailHtml('weekly_digest', { itemsJson: '[]' })!;
    expect(html).toContain('Quiet week');
    expect(html).toMatchSnapshot();
  });
  it('renders both sections in the HTML when both are present', () => {
    const html = buildBillingEmailHtml('weekly_digest', {
      itemsJson: JSON.stringify(items3),
      deployItemsJson: JSON.stringify(deploys2),
    })!;
    expect(html).toContain('5 things need attention');
    expect(html).toContain('>Functions<');
    expect(html).toContain('>Deployments<');
    expect(html).toContain('Edge SSR deploy');
    expect(html).toContain('Frontend deploy');
  });
  it('escapes HTML in user-controlled fields', () => {
    const html = buildBillingEmailHtml('weekly_digest', {
      itemsJson: JSON.stringify([{
        appId: 'app_x', appName: '<script>alert(1)</script>',
        functionName: 'fn"&<>', failureCount: 1, lastError: '</pre><img src=x>',
      }]),
    })!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('</pre><img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('fn&quot;&amp;&lt;&gt;');
  });
});

describe('isoWeekKey', () => {
  it('formats as YYYY-Www', () => {
    expect(isoWeekKey()).toMatch(/^\d{4}-W\d{2}$/);
  });
  it('same key for two adjacent days in the same ISO week', () => {
    // 2026-05-11 is a Monday, 2026-05-17 is a Sunday — same ISO week.
    expect(isoWeekKey(new Date('2026-05-11T00:00:00Z')))
      .toBe(isoWeekKey(new Date('2026-05-17T23:00:00Z')));
  });
  it('different key across week boundary', () => {
    expect(isoWeekKey(new Date('2026-05-17T23:00:00Z')))
      .not.toBe(isoWeekKey(new Date('2026-05-18T00:00:00Z'))); // Monday flips week
  });
});
