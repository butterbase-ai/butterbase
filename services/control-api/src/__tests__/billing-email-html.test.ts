import { describe, it, expect } from 'vitest';
import {
  buildBillingEmailBody,
  buildBillingEmailHtml,
  buildBillingEmailSubject,
  meterLabel,
  type BillingEmailTemplate,
} from '../services/auth/email-service.js';
import { renderEmailLayout } from '../services/auth/email-layout.js';

const OWNER_FOOTER = 'you own a Butterbase app';

describe('dynamic subjects', () => {
  it('names the app on failure alerts so different apps do not thread together', () => {
    expect(buildBillingEmailSubject('deployment_failed', { appName: 'Pantry', appId: 'app_1' })).toBe('[Pantry] Deployment failed');
    expect(buildBillingEmailSubject('provisioning_failed', { appName: 'Pantry' })).toBe('[Pantry] App setup failed');
    expect(buildBillingEmailSubject('auth_hook_failed', { appName: 'Pantry', hookFunction: 'on-login' }))
      .toBe('[Pantry] Auth hook "on-login" is failing');
  });

  it('names the meter with a human label on limit emails', () => {
    expect(buildBillingEmailSubject('hard_limit_exceeded', { meter: 'mau' })).toBe('Action required: monthly active users plan limit reached');
    expect(buildBillingEmailSubject('soft_limit_warning', { meter: 'ai_credits', percentage: '80' }))
      .toBe('Heads up: AI credits at 80% of your plan limit');
    expect(buildBillingEmailSubject('overage_warning', { meter: 'storage_bytes' }))
      .toBe('Storage is over your plan limit (overage will be billed)');
    expect(buildBillingEmailSubject('soft_limit_warning', { meter: 'storage_bytes' }))
      .not.toBe(buildBillingEmailSubject('soft_limit_warning', { meter: 'mau' }));
  });

  it('names amounts and dates on billing emails', () => {
    expect(buildBillingEmailSubject('auto_refill_failed', { amount_usd: '20.00' })).toBe('Action required: $20.00 auto-refill failed');
    expect(buildBillingEmailSubject('credits_low', { total_usd: '0.75' })).toBe('Your AI credits are running low ($0.75 left)');
    expect(buildBillingEmailSubject('payment_failed', { gracePeriodEndsAt: '2026-10-13T00:00:00Z' }))
      .toBe('Action required: payment failed, update by October 13, 2026');
    expect(buildBillingEmailSubject('soft_locked', { violations: 'mau: 60/50, bandwidth: 2.00GB/1GB' }))
      .toBe('Account limited: over the free plan limit for monthly active users, bandwidth');
  });

  it('counts orgs in the ops low-balance subject', () => {
    expect(buildBillingEmailSubject('org_balance_low_ops', { org_count: '3', cut_off_count: '1' }))
      .toBe('[butterbase] 3 orgs low on credits, 1 cut off');
    expect(buildBillingEmailSubject('org_balance_low_ops', { org_count: '1', cut_off_count: '0' }))
      .toBe('[butterbase] 1 org low on credits');
  });

  it('mentions template updates in a digest with nothing failing', () => {
    const templateUpdatesJson = JSON.stringify([{ dest_app_id: 'a', source_app_id: 'b', behind_by: 1, latest_label: null }]);
    expect(buildBillingEmailSubject('weekly_digest', { itemsJson: '[]', templateUpdatesJson }))
      .toBe('Your weekly digest: 1 template update available');
  });
});

describe('limit email bodies', () => {
  it('uses human meter labels and formats byte values', () => {
    const body = buildBillingEmailBody('hard_limit_exceeded', { meter: 'storage_bytes', current: '5368709120', limit: '5368709120' });
    expect(body).toContain('your storage plan limit');
    expect(body).toContain('Current usage: 5 GB');
    expect(body).not.toContain('storage_bytes');
    expect(meterLabel('ai_credits')).toBe('AI credits');
    expect(meterLabel('something_new')).toBe('something new');
  });
});

describe('HTML variants', () => {
  const ownerTemplates: Array<[BillingEmailTemplate, Record<string, string>]> = [
    ['payment_failed', { gracePeriodEndsAt: '2026-10-13T00:00:00Z' }],
    ['plan_downgraded', {}],
    ['soft_locked', { violations: 'mau: 60/50' }],
    ['account_suspended', { reason: 'Payment failure' }],
    ['overage_warning', { meter: 'api_calls', current: '1200', limit: '1000' }],
    ['soft_limit_warning', { meter: 'api_calls', current: '800', limit: '1000' }],
    ['hard_limit_warning', { meter: 'api_calls', current: '800', limit: '1000' }],
    ['hard_limit_exceeded', { meter: 'api_calls', current: '1000', limit: '1000' }],
    ['deployment_failed', { appId: 'app_1', appName: 'Pantry', deploymentId: 'dep_1', errorMessage: 'boom' }],
    ['provisioning_failed', { appId: 'app_1', appName: 'Pantry', provisioningError: 'boom' }],
    ['auth_hook_failed', { appId: 'app_1', appName: 'Pantry', hookFunction: 'h', event: 'login', errorMessage: 'boom' }],
    ['auto_refill_failed', { amount_usd: '20.00' }],
    ['credits_low', { total_usd: '0.75', dashboard_url: 'https://dash.example' }],
    ['credits_exhausted', { dashboard_url: 'https://dash.example' }],
  ];

  it.each(ownerTemplates)('%s renders HTML with the owner footer', (template, data) => {
    const html = buildBillingEmailHtml(template, data);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain(OWNER_FOOTER);
  });

  it('escapes user-controlled values', () => {
    const html = buildBillingEmailHtml('deployment_failed', {
      appId: 'app_1', appName: '<script>alert(1)</script>', deploymentId: 'd', errorMessage: '</pre><img src=x>',
    })!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('</pre><img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('ops templates use the ops footer, not the owner footer', () => {
    for (const [t, d] of [
      ['clone_failed_ops', { appId: 'app_1', jobId: 'job_1' }],
      ['org_balance_low_ops', { org_count: '1', cut_off_count: '0', threshold_usd: '1.00', orgs_json: '[]' }],
      ['clone_reaper_digest', { reapedCount: '1', detailsJson: '[]' }],
    ] as Array<[BillingEmailTemplate, Record<string, string>]>) {
      const html = buildBillingEmailHtml(t, d)!;
      expect(html).toContain('Internal Butterbase ops alert');
      expect(html).not.toContain(OWNER_FOOTER);
    }
  });

  it('ops clone HTML has no customer CTA', () => {
    const html = buildBillingEmailHtml('clone_failed_ops', { appId: 'app_1', jobId: 'job_1', mode: 'clone' })!;
    expect(html).not.toMatch(/try cloning again/i);
    expect(html).toContain('job_1');
  });

  it('credits links fall back to DASHBOARD_URL when dashboard_url is empty', () => {
    const html = buildBillingEmailHtml('credits_low', { total_usd: '0.50', dashboard_url: '' })!;
    expect(html).not.toContain('href="/billing');
    const body = buildBillingEmailBody('credits_exhausted', { dashboard_url: '' });
    expect(body).not.toMatch(/: \/billing/);
  });
});

describe('renderEmailLayout audience', () => {
  it('defaults to the owner footer', () => {
    expect(renderEmailLayout({ preheader: 'p', content: 'c' })).toContain(OWNER_FOOTER);
  });
  it('invitee footer does not claim the recipient owns an app', () => {
    const html = renderEmailLayout({ preheader: 'p', content: 'c', audience: 'invitee' });
    expect(html).not.toContain(OWNER_FOOTER);
    expect(html).toContain('invited this address');
  });
});
