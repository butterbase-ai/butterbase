import { describe, it, expect } from 'vitest';
import { scopeAppListToOrg } from '../loop.js';

// The dashboard agent scopes `manage_app` action:"list" results to the active
// org. `/apps` deliberately fans out across every org the user belongs to;
// scopeAppListToOrg narrows the MCP result envelope to a single org, and MUST
// fail open (return the input untouched) on any unexpected shape so scoping can
// never break the tool call.

/** Build the MCP tool-result envelope manage_app list returns. */
function envelope(apps: Array<{ id: string; organization_id: string | null }>) {
  return { content: [{ type: 'text', text: JSON.stringify({ apps }, null, 2) }] };
}

function appsFrom(result: unknown): Array<{ id: string; organization_id: string | null }> {
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(text).apps;
}

describe('scopeAppListToOrg', () => {
  it('keeps only apps in the target org', () => {
    const result = envelope([
      { id: 'app_a', organization_id: 'org_1' },
      { id: 'app_b', organization_id: 'org_2' },
      { id: 'app_c', organization_id: 'org_1' },
    ]);
    const scoped = scopeAppListToOrg(result, 'org_1');
    expect(appsFrom(scoped).map((a) => a.id)).toEqual(['app_a', 'app_c']);
  });

  it('preserves other top-level keys in the payload', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({ apps: [{ id: 'app_a', organization_id: 'org_1' }], note: 'hi' }) }] };
    const scoped = scopeAppListToOrg(result, 'org_2');
    const parsed = JSON.parse((scoped as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.apps).toEqual([]);
    expect(parsed.note).toBe('hi');
  });

  it('drops rows with a null / missing organization_id (no accidental leak)', () => {
    const result = envelope([
      { id: 'app_a', organization_id: 'org_1' },
      { id: 'app_b', organization_id: null },
    ]);
    const scoped = scopeAppListToOrg(result, 'org_1');
    expect(appsFrom(scoped).map((a) => a.id)).toEqual(['app_a']);
  });

  it('fails open on a non-envelope shape', () => {
    const weird = { unexpected: true };
    expect(scopeAppListToOrg(weird, 'org_1')).toBe(weird);
  });

  it('fails open when the text is not valid JSON', () => {
    const result = { content: [{ type: 'text', text: 'not json' }] };
    expect(scopeAppListToOrg(result, 'org_1')).toBe(result);
  });

  it('fails open when there is no apps array', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({ something: 1 }) }] };
    expect(scopeAppListToOrg(result, 'org_1')).toBe(result);
  });
});
