import { describe, it, expect } from 'vitest';
import { filterToolsByActiveWindow } from '../create-server.js';

describe('filterToolsByActiveWindow', () => {
  const all = [{ name: 'list_apps' }, { name: 'submit_hackathon_entry' }, { name: 'docs' }] as { name: string }[];

  it('hides hackathon tool when no active window', () => {
    expect(filterToolsByActiveWindow(all, false).map(t => t.name))
      .toEqual(['list_apps', 'docs']);
  });

  it('includes hackathon tool when active window', () => {
    expect(filterToolsByActiveWindow(all, true).map(t => t.name))
      .toEqual(['list_apps', 'submit_hackathon_entry', 'docs']);
  });

  it('includes all non-hackathon tools regardless of active window', () => {
    const nonHackathon = filterToolsByActiveWindow(all, false);
    expect(nonHackathon.every(t => t.name !== 'submit_hackathon_entry')).toBe(true);
    expect(nonHackathon.length).toBe(2);
  });
});
