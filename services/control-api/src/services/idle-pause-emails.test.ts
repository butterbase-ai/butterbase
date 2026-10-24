import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBillingEmailBody, buildBillingEmailHtml, buildBillingEmailSubject } from './auth/email-service.js';

describe('idle pause email copy', () => {
  it('warns with three choices and the configured lead time', () => {
    const data = { appName: 'Pantry', appId: 'app_pantry', warnDays: '7' };
    expect(buildBillingEmailSubject('project_idle_warning', data)).toContain('Pantry will pause in 7 days');
    const text = buildBillingEmailBody('project_idle_warning', data);
    expect(text).toContain('real traffic'); expect(text).toContain('upgrade'); expect(text).toContain('do nothing');
    expect(text).not.toMatch(/keep it running.*https:/i);
    const html = buildBillingEmailHtml('project_idle_warning', { ...data, appName: '<img src=x>' })!;
    expect(html).toContain('&lt;img src=x&gt;'); expect(html).not.toContain('<img src=x>');
    expect(html).toContain('/billing/upgrade'); expect(html).toContain('/apps/app_pantry');
    expect(html).toContain('you own a Butterbase app');
  });
  it('sends an upgrade-only paused notice without revealing the grace period', () => {
    const data = { appName: 'Pantry', appId: 'app_pantry' };
    expect(buildBillingEmailSubject('project_paused_idle', data)).toContain('Pantry has been paused');
    for (const body of [buildBillingEmailBody('project_paused_idle', data), buildBillingEmailHtml('project_paused_idle', data)!]) {
      expect(body).toMatch(/upgrade/i); expect(body).toMatch(/paid plans don.t pause/i);
      expect(body).not.toMatch(/grace|5 days|keep it running|resume for free/i);
    }
  });
  it('renders the circuit breaker as an internal ops alert', () => {
    const data = { count: '26', freeApps: '100' };
    expect(buildBillingEmailBody('idle_pause_breaker_ops', data)).toContain('26');
    expect(buildBillingEmailHtml('idle_pause_breaker_ops', data)).toContain('Internal Butterbase ops alert');
  });
});
