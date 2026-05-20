import { describe, it, expect } from 'vitest';
import { buildBillingEmailBody } from '../services/auth/email-service.js';

describe('credits_low email', () => {
  it('renders with monthly + topup breakdown', () => {
    const html = buildBillingEmailBody('credits_low', {
      total_usd: '0.75',
      monthly_allowance_usd: '0.50',
      topup_usd: '0.25',
      reset_date: 'May 31',
      dashboard_url: 'https://dashboard.butterbase.ai',
    });
    expect(html).toMatchSnapshot();
  });

  it('omits reset date when empty', () => {
    const html = buildBillingEmailBody('credits_low', {
      total_usd: '0.50',
      monthly_allowance_usd: '0.00',
      topup_usd: '0.50',
      dashboard_url: 'https://dashboard.butterbase.ai',
    });
    expect(html).toMatchSnapshot();
  });
});

describe('credits_exhausted email', () => {
  it('renders CTAs for top-up and auto-refill', () => {
    const html = buildBillingEmailBody('credits_exhausted', {
      dashboard_url: 'https://dashboard.butterbase.ai',
    });
    expect(html).toMatchSnapshot();
  });
});
