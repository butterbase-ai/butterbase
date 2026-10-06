import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  // config is read at import time.
  process.env.SES_CONFIGURATION_SET = 'cs-test';
  return { mockSend: vi.fn() };
});

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: vi.fn().mockImplementation((input) => ({ kind: 'simple', input })),
  SendRawEmailCommand: vi.fn().mockImplementation((input) => ({ kind: 'raw', input })),
}));

import { sendBillingEmail, buildRawMimeMessage } from '../email-service.js';

afterAll(() => {
  delete process.env.SES_CONFIGURATION_SET;
});

function decodeParts(raw: string): string {
  // Concatenate every base64 body block, decoded.
  return raw.split(/\r\n\r\n/).slice(1).map((chunk) => {
    const b64 = chunk.split(/\r\n--/)[0].replace(/\r\n/g, '');
    return /^[A-Za-z0-9+/=]+$/.test(b64) ? Buffer.from(b64, 'base64').toString('utf8') : '';
  }).join('\n');
}

describe('buildRawMimeMessage', () => {
  it('writes custom headers and a multipart/alternative body', () => {
    const raw = buildRawMimeMessage({
      from: 'Butterbase <noreply@example.com>',
      to: 'a@example.com',
      subject: 'Hello',
      text: 'plain body',
      html: '<p>html body</p>',
      headers: { 'List-Unsubscribe': '<https://api.example/x>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect(raw).toContain('\r\nList-Unsubscribe: <https://api.example/x>\r\n');
    expect(raw).toContain('\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    const decoded = decodeParts(raw);
    expect(decoded).toContain('plain body');
    expect(decoded).toContain('<p>html body</p>');
  });

  it('strips CR/LF from header values (no header injection via app names)', () => {
    const raw = buildRawMimeMessage({
      from: 'Butterbase <noreply@example.com>',
      to: 'a@example.com',
      subject: '[evil\r\nBcc: victim@example.com] Deployment failed',
      text: 't',
      html: null,
    });
    const headerBlock = raw.split('\r\n\r\n')[0];
    expect(headerBlock).not.toMatch(/^Bcc:/m);
  });

  it('RFC 2047-encodes non-ASCII subjects', () => {
    const raw = buildRawMimeMessage({ from: 'B <n@e.com>', to: 'a@e.com', subject: 'Café ☕ alerts', text: 't', html: null });
    const subjectLine = raw.split('\r\n').find((l) => l.startsWith('Subject:'))!;
    expect(subjectLine).toMatch(/=\?UTF-8\?B\?/);
    const b64 = subjectLine.match(/=\?UTF-8\?B\?([^?]+)\?=/)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Café ☕ alerts');
  });
});

describe('sendBillingEmail', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it("returns 'sent' and attaches the configuration set", async () => {
    await expect(sendBillingEmail('a@example.com', 'credits_exhausted', {})).resolves.toBe('sent');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.kind).toBe('simple');
    expect(cmd.input.ConfigurationSetName).toBe('cs-test');
    expect(cmd.input.Message.Body.Html.Data).toContain('<!DOCTYPE html>');
  });

  it("returns 'failed' (never throws) when SES rejects outside development", async () => {
    mockSend.mockRejectedValueOnce(new Error('SES down'));
    await expect(sendBillingEmail('a@example.com', 'credits_exhausted', {})).resolves.toBe('failed');
  });

  it('sends List-Unsubscribe one-click headers when an unsubscribe token is supplied', async () => {
    const token = 't'.repeat(43);
    await sendBillingEmail('a@example.com', 'function_failed', {
      appId: 'app_1', appName: 'Pantry', functionName: 'f', errorMessage: 'boom', streakLen: '3',
    }, { actionTokens: { unsubscribeTemplate: token } });
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.kind).toBe('raw');
    expect(cmd.input.ConfigurationSetName).toBe('cs-test');
    expect(cmd.input.Destinations).toEqual(['a@example.com']);
    const raw = Buffer.from(cmd.input.RawMessage.Data).toString('utf8');
    expect(raw).toContain(`List-Unsubscribe: <https://api.butterbase.ai/v1/notif/action/${token}>`);
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(raw).toContain('Subject: [Pantry] "f" failed 3 times in a row');
  });
});

describe('sendBillingEmail app display name', () => {
  beforeEach(() => mockSend.mockReset().mockResolvedValue({}));

  it('title-cases slug app names in owner-facing subjects', async () => {
    await sendBillingEmail('o@example.com', 'deployment_failed', { appName: 'acme-notes', appId: 'app_1' });
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Message.Subject.Data).toContain('Acme Notes');
    expect(cmd.input.Message.Subject.Data).not.toContain('acme-notes');
  });

  it('keeps the raw slug in ops alerts', async () => {
    await sendBillingEmail('ops@example.com', 'clone_failed_ops', { appName: 'acme-notes', appId: 'app_1', jobId: 'j1' });
    const cmd = mockSend.mock.calls[0][0];
    const all = JSON.stringify(cmd.input);
    expect(all).not.toContain('Acme Notes');
  });
});
