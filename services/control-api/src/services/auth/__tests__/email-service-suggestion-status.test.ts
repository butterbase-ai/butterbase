import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mockSend is initialised before vi.mock's factory runs
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: vi.fn().mockImplementation((input) => input),
}));

import { sendSuggestionStatusUpdateEmail } from '../email-service.js';

describe('sendSuggestionStatusUpdateEmail', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('sends an email with a human-readable status label', async () => {
    await sendSuggestionStatusUpdateEmail('user@example.com', {
      id: 'abc-123',
      description: 'Add dark mode support',
      status: 'implemented',
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0];
    expect(command.Destination.ToAddresses).toEqual(['user@example.com']);
    expect(command.Message.Subject.Data).toContain('Implemented');
    expect(command.Message.Body.Text.Data).toContain('Add dark mode support');
    expect(command.Message.Body.Text.Data).toContain('Implemented');
  });

  it("uses \"Won't Fix\" label for wont_fix status", async () => {
    await sendSuggestionStatusUpdateEmail('user@example.com', {
      id: 'abc-123',
      description: 'Some suggestion',
      status: 'wont_fix',
    });

    const command = mockSend.mock.calls[0][0];
    expect(command.Message.Subject.Data).toContain("Won't Fix");
  });

  it('does not throw in development when SES send fails', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    mockSend.mockRejectedValueOnce(new Error('SES unavailable'));

    await expect(
      sendSuggestionStatusUpdateEmail('user@example.com', {
        id: 'abc-123',
        description: 'Some suggestion',
        status: 'acknowledged',
      })
    ).resolves.not.toThrow();

    process.env.NODE_ENV = originalEnv;
  });
});
