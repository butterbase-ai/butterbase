import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mockSend is initialised before vi.mock's factory runs
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: vi.fn().mockImplementation((input) => input),
}));

import { sendInviteEmail } from '../email-service.js';

describe('sendInviteEmail', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('calls SES with correct to/subject/body fields', async () => {
    await sendInviteEmail({
      toEmail: 'alice@example.com',
      orgName: 'Acme',
      inviterEmail: 'bob@example.com',
      inviteUrl: 'https://dash.butterbase.ai/invite/abc',
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    });
    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0];
    expect(command.Destination.ToAddresses).toEqual(['alice@example.com']);
    expect(command.Message.Subject.Data).toContain('Acme');
    expect(command.Message.Subject.Data).toContain('bob@example.com');
    expect(command.Message.Body.Html.Data).toContain('Accept invite');
    expect(command.Message.Body.Text.Data).toContain('https://dash.butterbase.ai/invite/abc');
  });

  it('never throws when SES fails — fire-and-forget contract', async () => {
    mockSend.mockRejectedValueOnce(new Error('SES unavailable'));
    await expect(sendInviteEmail({
      toEmail: 'x@y',
      orgName: 'Org',
      inviterEmail: 'sender@example.com',
      inviteUrl: 'https://dash.butterbase.ai/invite/xyz',
      expiresAt: new Date(),
    })).resolves.toBeUndefined();
  });

  it('escapes HTML in org name and inviter email', async () => {
    await sendInviteEmail({
      toEmail: 'alice@example.com',
      orgName: '<Evil Org>',
      inviterEmail: 'evil@example.com',
      inviteUrl: 'https://dash.butterbase.ai/invite/abc',
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    });
    const command = mockSend.mock.calls[0][0];
    expect(command.Message.Body.Html.Data).not.toContain('<Evil Org>');
    expect(command.Message.Body.Html.Data).toContain('&lt;Evil Org&gt;');
  });
});
