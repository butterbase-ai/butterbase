import { describe, expect, it } from 'vitest';
import { referencesForApproval } from './approval-references.js';

function one(toolName: string, args: unknown, result: unknown) {
  return referencesForApproval({
    toolName,
    toolArgs: args,
    toolCalls: [{ id: 'call-1', name: toolName, args }],
    toolResults: [{ id: 'call-1', result }],
  });
}

describe('referencesForApproval', () => {
  it('reads entities the operator found', () => {
    expect(one('manage_substrate', { action: 'find_entities' }, {
      entities: [
        { id: 'ent_1', type: 'person', display_name: 'Marcus Webb' },
      ],
    })).toEqual([
      { kind: 'entity', id: 'ent_1', label: 'Marcus Webb', detail: 'person' },
    ]);
  });

  it('reads a single entity', () => {
    expect(one('manage_substrate', { action: 'get_entity' }, {
      id: 'ent_2', type: 'company', display_name: 'Northline',
    })).toEqual([
      { kind: 'entity', id: 'ent_2', label: 'Northline', detail: 'company' },
    ]);
  });

  it('reads source artifacts and memory', () => {
    expect(one('manage_substrate', { action: 'list_source_artifacts' }, {
      source_artifacts: [{ id: 'art_1', title: 'Invoice thread', kind: 'email_thread' }],
    })).toEqual([
      { kind: 'artifact', id: 'art_1', label: 'Invoice thread', detail: 'email_thread' },
    ]);

    expect(one('manage_substrate', { action: 'search_memory' }, {
      results: [{ id: 'dec_1', title: 'Invoice on the first', kind: 'decision' }],
    })).toEqual([
      { kind: 'record', id: 'dec_1', label: 'Invoice on the first', detail: 'decision' },
    ]);
  });

  it('reads storage files, apps, repo files and schema tables', () => {
    expect(one('manage_storage', { action: 'list' }, {
      objects: [{ id: 'obj_1', key: 'invoices/1042.pdf', filename: 'invoice-1042.pdf', content_type: 'application/pdf' }],
    })).toEqual([
      { kind: 'file', id: 'obj_1', label: 'invoice-1042.pdf', detail: 'application/pdf' },
    ]);

    expect(one('manage_app', { action: 'list' }, {
      apps: [{ id: 'app_1', name: 'Fieldwork' }],
    })).toEqual([
      { kind: 'app', id: 'app_1', label: 'Fieldwork' },
    ]);

    expect(one('manage_repo', { action: 'pull_latest' }, {
      snapshot_id: 'snap_1',
      files: [{ path: 'src/App.tsx' }],
    })).toEqual([
      { kind: 'file', id: 'src/App.tsx', label: 'src/App.tsx' },
    ]);

    expect(one('manage_schema', { action: 'get' }, {
      schema: { tables: { invoices: { columns: {} }, clients: { columns: {} } } },
    })).toEqual([
      { kind: 'record', id: 'invoices', label: 'invoices' },
      { kind: 'record', id: 'clients', label: 'clients' },
    ]);
  });

  it('ignores writes and unknown tools', () => {
    expect(one('manage_substrate', { action: 'propose', capability: 'send_email_draft' }, {
      entities: [{ id: 'ent_1', display_name: 'Marcus Webb' }],
    })).toEqual([]);
    expect(one('manage_unknown', { action: 'list' }, {
      entities: [{ id: 'ent_1', display_name: 'Marcus Webb' }],
    })).toEqual([]);
  });

  it('drops ids, dedupes and caps at five', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `ent_${i}`,
      display_name: `Person ${i}`,
    }));
    const result = one('manage_substrate', { action: 'find_entities' }, {
      entities: [
        ...many,
        { id: 'ent_0', display_name: 'Person 0' },
        { id: 'ent_uuid', display_name: '11111111-1111-4111-8111-111111111111' },
      ],
    });

    expect(result).toHaveLength(5);
    expect(new Set(result.map((ref) => ref.label)).size).toBe(5);
    expect(result.some((ref) => /^[0-9a-f-]{36}$/i.test(ref.label))).toBe(false);
  });

  it('returns nothing when the payload has no human label', () => {
    expect(one('manage_substrate', { action: 'find_entities' }, {
      entities: [{ id: 'ent_1' }],
    })).toEqual([]);
  });
});
