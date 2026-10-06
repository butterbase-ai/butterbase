import { describe, it, expect, vi } from 'vitest';
import { deriveSnapshotTitle, type SnapshotTitleGateway } from '../snapshot-title.js';

describe('deriveSnapshotTitle', () => {
  it('returns the trimmed user message verbatim when it is short (<120 chars)', async () => {
    const gateway: SnapshotTitleGateway = { chat: vi.fn() };

    const title = await deriveSnapshotTitle(
      '  Add a dark mode toggle  ',
      'Done, added the toggle.',
      gateway,
      1,
    );

    expect(title).toBe('Add a dark mode toggle');
    expect(gateway.chat).not.toHaveBeenCalled();
  });

  it('calls the gateway and uses its response when the user message is long (>=120 chars)', async () => {
    const longMessage =
      'Please refactor the entire dashboard layout to use a new sidebar component, update the routing, ' +
      'and make sure the mobile breakpoint still works correctly across all pages.';
    expect(longMessage.length).toBeGreaterThanOrEqual(120);

    const chat = vi.fn().mockResolvedValue('Refactor dashboard layout and sidebar');
    const gateway: SnapshotTitleGateway = { chat };

    const title = await deriveSnapshotTitle(longMessage, 'Refactored the layout.', gateway, 3);

    expect(title).toBe('Refactor dashboard layout and sidebar');
    expect(chat).toHaveBeenCalledTimes(1);
    const callArg = chat.mock.calls[0][0] as { prompt: string; timeoutMs: number };
    expect(callArg.prompt).toContain('Summarize this exchange in 4-8 words as a title. No quotes.');
    expect(callArg.prompt).toContain(longMessage);
    expect(callArg.prompt).toContain('Refactored the layout.');
    expect(callArg.timeoutMs).toBe(5000);
  });

  it('falls back to "Turn <N>" when the gateway throws', async () => {
    const longMessage = 'x'.repeat(150);
    const gateway: SnapshotTitleGateway = {
      chat: vi.fn().mockRejectedValue(new Error('gateway 500')),
    };

    const title = await deriveSnapshotTitle(longMessage, 'assistant text', gateway, 7);

    expect(title).toBe('Turn 7');
  });

  it('falls back to "Turn <N>" when the gateway times out (rejects)', async () => {
    const longMessage = 'y'.repeat(150);
    const gateway: SnapshotTitleGateway = {
      chat: vi.fn().mockImplementation(() => new Promise((_, reject) => {
        reject(new Error('aborted'));
      })),
    };

    const title = await deriveSnapshotTitle(longMessage, 'assistant text', gateway, 2);

    expect(title).toBe('Turn 2');
  });

  it('falls back to "Turn <N>" when the gateway resolves with an empty string', async () => {
    const longMessage = 'z'.repeat(150);
    const gateway: SnapshotTitleGateway = { chat: vi.fn().mockResolvedValue('') };

    const title = await deriveSnapshotTitle(longMessage, 'assistant text', gateway, 5);

    expect(title).toBe('Turn 5');
  });
});
