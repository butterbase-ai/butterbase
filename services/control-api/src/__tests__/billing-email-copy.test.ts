import { describe, it, expect } from 'vitest';
import {
  buildBillingEmailBody,
  buildBillingEmailSubject,
  formatEmailDate,
} from '../services/auth/email-service.js';

describe('formatEmailDate', () => {
  it('formats ISO strings and Dates in UTC', () => {
    expect(formatEmailDate('2026-10-13T12:00:00.000Z')).toBe('October 13, 2026');
    expect(formatEmailDate(new Date('2026-01-02T23:59:00Z'))).toBe('January 2, 2026');
  });

  it('leaves already-formatted or free text alone', () => {
    expect(formatEmailDate('May 31')).toBe('May 31');
    expect(formatEmailDate('the end of the month')).toBe('the end of the month');
    expect(formatEmailDate('')).toBe('');
    expect(formatEmailDate(undefined)).toBe('');
  });
});

describe('payment_failed', () => {
  it('shows the grace-period end as a human date, not an ISO string', () => {
    const body = buildBillingEmailBody('payment_failed', { gracePeriodEndsAt: '2026-10-13T12:00:00.000Z' });
    expect(body).toContain('remain active until October 13, 2026');
    expect(body).not.toContain('T12:00:00');
  });
});

describe('plan_downgraded', () => {
  it('says the account was downgraded, never that it remains active', () => {
    const body = buildBillingEmailBody('plan_downgraded', { gracePeriodEndedAt: '2026-10-13T12:00:00.000Z' });
    expect(body).toContain('ended on October 13, 2026');
    expect(body).toContain('free Playground plan');
    expect(body).toContain('/billing');
    expect(body).not.toMatch(/remain active/i);
  });

  it('copes without a date', () => {
    const body = buildBillingEmailBody('plan_downgraded', {});
    expect(body).toContain('grace period has ended');
  });
});

describe('auto_refill_failed', () => {
  it('does not ask the user to reply to a noreply address', () => {
    const body = buildBillingEmailBody('auto_refill_failed', { amount_usd: '20.00' });
    expect(body).not.toMatch(/reply to this email/i);
    expect(body).toContain('contact support');
  });
});

describe('clone_failed_ops', () => {
  const data = {
    appId: 'app_abc',
    appName: 'Pantry',
    sourceAppId: 'app_tpl',
    jobId: 'job_123',
    errorMessage: 'boom',
    stalledStage: 'deploy_functions',
    mode: 'update',
    organizationId: 'org_9',
    ownerEmail: 'owner@example.com',
  };

  it('has an ops subject naming the app and job', () => {
    expect(buildBillingEmailSubject('clone_failed_ops', data))
      .toBe('[butterbase] Clone failed: app_abc (update) job job_123');
    expect(buildBillingEmailSubject('clone_failed_ops', { ...data, mode: 'clone' }))
      .toBe('[butterbase] Clone failed: app_abc job job_123');
  });

  it('carries ops identifiers and no customer CTA', () => {
    const body = buildBillingEmailBody('clone_failed_ops', data);
    for (const s of ['job_123', 'app_abc', 'Pantry', 'app_tpl', 'org_9', 'owner@example.com', 'deploy_functions', 'boom']) {
      expect(body).toContain(s);
    }
    expect(body).not.toMatch(/try cloning again/i);
  });
});
