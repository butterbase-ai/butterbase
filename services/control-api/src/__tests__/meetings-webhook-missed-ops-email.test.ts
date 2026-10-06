import { describe, it, expect } from 'vitest';
import {
  buildBillingEmailBody,
  buildBillingEmailHtml,
  buildBillingEmailSubject,
} from '../services/auth/email-service.js';

const DATA = {
  bot_count: '3',
  usd: '1.42',
  bot_ids: 'bot_a,bot_b,bot_c',
};

describe('meetings_webhook_missed_ops email', () => {
  it('puts the count and amount in the subject', () => {
    const subject = buildBillingEmailSubject('meetings_webhook_missed_ops', DATA);
    expect(subject).toContain('3');
    expect(subject).toContain('$1.42');
  });

  it('says the webhook is the thing to check', () => {
    const body = buildBillingEmailBody('meetings_webhook_missed_ops', DATA);
    expect(body.toLowerCase()).toContain('webhook');
    expect(body).toContain('$1.42');
  });

  it('lists the bot ids so they can be traced', () => {
    const body = buildBillingEmailBody('meetings_webhook_missed_ops', DATA);
    for (const id of ['bot_a', 'bot_b', 'bot_c']) expect(body).toContain(id);
  });

  it('renders an ops HTML email with the bot ids escaped', () => {
    const html = buildBillingEmailHtml('meetings_webhook_missed_ops', { ...DATA, bot_ids: '<x>' });
    expect(html).toBeTruthy();
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('still renders when the bot id list is missing', () => {
    const body = buildBillingEmailBody('meetings_webhook_missed_ops', { bot_count: '1', usd: '0.10' });
    expect(body).toContain('1');
  });
});
