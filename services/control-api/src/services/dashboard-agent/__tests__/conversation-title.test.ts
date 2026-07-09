import { describe, it, expect, vi } from 'vitest';
import { generateConversationTitle } from '../conversation-title.js';
import type { SnapshotTitleGateway } from '../snapshot-title.js';

describe('generateConversationTitle', () => {
  it('generates a title for a short exchange', async () => {
    const chat = vi.fn().mockResolvedValue('Todo App Setup');
    const gateway: SnapshotTitleGateway = { chat };

    const title = await generateConversationTitle('Help me build a todo app', 'Sure, scaffolding now.', gateway);

    expect(title).toBe('Todo App Setup');
    expect(chat).toHaveBeenCalledTimes(1);
    const callArg = chat.mock.calls[0][0] as { prompt: string; timeoutMs: number };
    expect(callArg.prompt).toContain('Summarize this exchange as a 3-6 word conversation title. No quotes. No trailing period.');
    expect(callArg.prompt).toContain('Help me build a todo app');
    expect(callArg.prompt).toContain('Sure, scaffolding now.');
    expect(callArg.timeoutMs).toBe(6000);
  });

  it('returns null when the gateway times out / rejects', async () => {
    const gateway: SnapshotTitleGateway = {
      chat: vi.fn().mockRejectedValue(new Error('aborted')),
    };

    const title = await generateConversationTitle('Help me build a todo app', 'Sure, scaffolding now.', gateway);

    expect(title).toBeNull();
  });

  it('returns null when the gateway resolves with an empty string', async () => {
    const gateway: SnapshotTitleGateway = { chat: vi.fn().mockResolvedValue('   ') };

    const title = await generateConversationTitle('Hello', 'Hi there', gateway);

    expect(title).toBeNull();
  });
});
