import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBillingEmailBody, buildBillingEmailHtml, buildBillingEmailSubject } from './auth/email-service.js';

describe('idle pause email copy', () => {
  it('renders the three-day reminder and links to the correct organization billing page', () => {
    const data = { appName: 'Pantry', appId: 'app_pantry', organizationId: 'org_team', warnDays: '3' };
    expect(buildBillingEmailSubject('project_idle_reminder', data)).toBe('Reminder: Pantry pauses in 3 days');
    for (const body of [buildBillingEmailBody('project_idle_reminder', data), buildBillingEmailHtml('project_idle_reminder', data)!]) {
      expect(body).toContain('3 days'); expect(body).toContain('real traffic');
      expect(body).toContain('/organizations/org_team/billing'); expect(body).toContain('/apps/app_pantry');
      expect(body).not.toMatch(/grace|21 days|billing\/upgrade/i);
    }
  });
  it('warns with three choices and the configured lead time', () => {
    const data = { appName: 'Pantry', appId: 'app_pantry', warnDays: '7' };
    expect(buildBillingEmailSubject('project_idle_warning', data)).toContain('Pantry will pause in 7 days');
    const text = buildBillingEmailBody('project_idle_warning', data);
    expect(text).toContain('real traffic'); expect(text).toContain('upgrade'); expect(text).toContain('no action is required');
    expect(text).not.toMatch(/keep it running.*https:/i);
    const html = buildBillingEmailHtml('project_idle_warning', { ...data, appName: '<img src=x>' })!;
    expect(html).toContain('&lt;img src=x&gt;'); expect(html).not.toContain('<img src=x>');
    expect(html).toContain('/billing'); expect(html).not.toContain('/billing/upgrade'); expect(html).toContain('/apps/app_pantry');
    expect(html).toContain('you own a Butterbase app');
  });
  it('sends an upgrade-only paused notice without revealing the grace period', () => {
    const data = { appName: 'Pantry', appId: 'app_pantry' };
    expect(buildBillingEmailSubject('project_paused_idle', data)).toContain('Pantry has been paused');
    for (const body of [buildBillingEmailBody('project_paused_idle', data), buildBillingEmailHtml('project_paused_idle', data)!]) {
      expect(body).toMatch(/upgrade/i); expect(body).toMatch(/paid plans do not pause/i);
      expect(body).not.toMatch(/grace|5 days|7 days|keep it running|resume for free/i);
    }
  });
  it('renders the circuit breaker as an internal ops alert', () => {
    const data = { count: '26', freeApps: '100' };
    expect(buildBillingEmailBody('idle_pause_breaker_ops', data)).toContain('26');
    expect(buildBillingEmailHtml('idle_pause_breaker_ops', data)).toContain('Internal Butterbase ops alert');
  });
});
