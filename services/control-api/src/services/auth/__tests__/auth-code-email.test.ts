import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mockSend is initialised before vi.mock's factory runs
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: vi.fn().mockImplementation((input) => input),
}));

import {
  sendMagicLinkEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  formatAppDisplayName,
} from '../email-service.js';

const cases = [
  { name: 'sendMagicLinkEmail', fn: sendMagicLinkEmail, label: 'sign-in code', expiry: '15 minutes' },
  { name: 'sendVerificationEmail', fn: sendVerificationEmail, label: 'verification code', expiry: '24 hours' },
  { name: 'sendPasswordResetEmail', fn: sendPasswordResetEmail, label: 'password reset code', expiry: '1 hour' },
] as const;

describe('formatAppDisplayName', () => {
  it('title-cases slug-shaped names', () => {
    expect(formatAppDisplayName('acme-notes')).toBe('Acme Notes');
    expect(formatAppDisplayName('my_cool_app')).toBe('My Cool App');
    expect(formatAppDisplayName('todo')).toBe('Todo');
  });

  it('keeps names the developer already formatted', () => {
    expect(formatAppDisplayName('My App')).toBe('My App');
    expect(formatAppDisplayName('myApp')).toBe('myApp');
  });

  it('returns null for empty input and strips control characters', () => {
    expect(formatAppDisplayName(null)).toBeNull();
    expect(formatAppDisplayName(undefined)).toBeNull();
    expect(formatAppDisplayName('   ')).toBeNull();
    expect(formatAppDisplayName('Evil\r\nBcc: x@y')).toBe('Evil Bcc: x@y');
  });
});

describe.each(cases)('$name', ({ fn, label, expiry }) => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('puts the app name and code in the subject and uses a readable From name', async () => {
    await fn('alice@example.com', '558817', 'acme-notes');
    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0];
    expect(command.Destination.ToAddresses).toEqual(['alice@example.com']);
    expect(command.Message.Subject.Data).toBe(`Your Acme Notes ${label} is 558817`);
    expect(command.Source).toMatch(/^"Acme Notes" </);
  });

  it('sends an HTML part containing the code plus the Text part', async () => {
    await fn('alice@example.com', '558817', 'acme-notes');
    const command = mockSend.mock.calls[0][0];
    const html: string = command.Message.Body.Html.Data;
    const text: string = command.Message.Body.Text.Data;
    expect(html).toContain('user-select:all;">558817</span>');
    expect(html).toContain('Acme Notes');
    expect(html).toContain(expiry);
    expect(html).toContain('Sent via Butterbase');
    expect(html).not.toContain('you own a Butterbase app');
    expect(text).toContain('558817');
    expect(text).toContain(expiry);
  });

  it('escapes a malicious app name in the HTML', async () => {
    await fn('alice@example.com', '123456', '<script>alert(1)</script>');
    const command = mockSend.mock.calls[0][0];
    const html: string = command.Message.Body.Html.Data;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // From header still sanitised
    expect(command.Source).not.toMatch(/<script>/);
  });

  it('falls back gracefully when there is no app name', async () => {
    await fn('alice@example.com', '654321', null);
    const command = mockSend.mock.calls[0][0];
    expect(command.Message.Subject.Data).toBe(`Your ${label} is 654321`);
    expect(command.Message.Body.Html.Data).toContain('654321');
    expect(command.Message.Body.Html.Data).toContain("This is an automated message. Please don't reply");
    expect(command.Message.Body.Text.Data).toContain('654321');
  });
});
