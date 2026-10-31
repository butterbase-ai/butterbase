import { afterEach, describe, expect, it } from 'vitest';
import { resolveOfficeMemoryContext, setOfficeMemoryContextProvider } from '../office-memory-types.js';
import { formatOfficeTaskNotes, readOfficeTaskNotes } from '../operator-scratchpad-store.js';
import { buildWakeMessage } from '../operator-turn.js';

afterEach(() => setOfficeMemoryContextProvider(undefined));
describe('optional Office memory integration', () => {
  it('passes trusted role/mode context to one provider for every Office turn kind', async () => {
    const seen: boolean[] = [];
    setOfficeMemoryContextProvider(async scope => { seen.push(scope.readOnly); return { text: 'compact titles', tools: (name, args) => ({ name, args }) }; });
    for (const readOnly of [false, true]) {
      expect((await resolveOfficeMemoryContext({ organizationId: 'org', userId: 'owner', model: 'test', autonomous: false, readOnly }))?.text).toBe('compact titles');
    }
    expect(seen).toEqual([false, true]);
  });
  it('legacy_scratchpad_is_not_injected but explicitly read contents remain stored', () => {
    expect(readOfficeTaskNotes('Legacy durable fact from an old sweep')).toBeNull();
    expect(readOfficeTaskNotes(formatOfficeTaskNotes('Waiting for approval act_one'))).toBe('Waiting for approval act_one');
    setOfficeMemoryContextProvider(async () => ({ text: 'index', tools: (name, args) => ({ name, args }) }));
    const job = { organizationId: 'org', name: 'sweep', instructions: 'Current routine' } as never;
    const wake = { reason: 'timer' } as never;
    expect(buildWakeMessage(job, wake, { content: 'LEGACY_SECRET', organizationId: 'org', updatedAt: 'now' })).not.toContain('LEGACY_SECRET');
    expect(buildWakeMessage(job, wake, { content: formatOfficeTaskNotes('Waiting for act_one'), organizationId: 'org', updatedAt: 'now' })).toContain('Waiting for act_one');
  });
});
