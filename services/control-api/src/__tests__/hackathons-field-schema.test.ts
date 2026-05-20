import { describe, expect, it } from 'vitest';
import {
  normalizeFieldSchemaInput,
  validateMetaSchema,
  validateSubmissionData,
  KNOWN_FIELD_TYPES,
  getUrlFieldKey,
} from '../services/hackathons/field-schema.js';

describe('normalizeFieldSchemaInput', () => {
  it('preserves per-field description and maps display always → primary', () => {
    const raw = {
      fields: [
        { key: 'a', type: 'text', required: true, display: 'always', label: 'A', description: 'hint' },
        { key: 'b', type: 'url', required: false, display: 'detail', label: 'B', description: '', is_url: true },
      ],
    };
    const normalized = normalizeFieldSchemaInput(raw);
    const r = validateMetaSchema(normalized);
    expect(r.ok).toBe(true);
    expect(normalized).toEqual({
      fields: [
        { key: 'a', type: 'text', required: true, display: 'primary', label: 'A', description: 'hint' },
        { key: 'b', type: 'url', required: false, display: 'detail', label: 'B', description: '', is_url: true },
      ],
    });
  });

  it('strips truly unknown per-field keys', () => {
    const raw = {
      fields: [
        { key: 'a', type: 'text', required: true, display: 'primary', label: 'A', surprise: 'gotcha' },
      ],
    };
    const normalized = normalizeFieldSchemaInput(raw) as { fields: Record<string, unknown>[] };
    expect('surprise' in normalized.fields[0]).toBe(false);
    expect(validateMetaSchema(normalized).ok).toBe(true);
  });

  it('defaults missing display to primary when the field is otherwise complete', () => {
    const raw = {
      fields: [{ key: 'x', type: 'text', required: false, label: 'X' }],
    };
    const normalized = normalizeFieldSchemaInput(raw);
    const r = validateMetaSchema(normalized);
    expect(r.ok).toBe(true);
    expect((normalized as { fields: { display: string }[] }).fields[0].display).toBe('primary');
  });
});

describe('validateMetaSchema', () => {
  it('accepts a minimal valid schema', () => {
    const r = validateMetaSchema({ fields: [{ key: 'project_name', type: 'text', required: true, display: 'primary', label: 'Project' }] });
    expect(r.ok).toBe(true);
  });

  it('rejects missing fields array', () => {
    const r = validateMetaSchema({} as unknown);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown field type', () => {
    const r = validateMetaSchema({ fields: [{ key: 'x', type: 'banana', required: false, display: 'primary', label: 'X' }] });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate field keys', () => {
    const r = validateMetaSchema({ fields: [
      { key: 'x', type: 'text', required: false, display: 'primary', label: 'X' },
      { key: 'x', type: 'url',  required: false, display: 'detail',  label: 'X2' },
    ]});
    expect(r.ok).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/duplicate/i);
  });

  it('requires options on enum fields', () => {
    const r = validateMetaSchema({ fields: [{ key: 'cat', type: 'enum', required: false, display: 'primary', label: 'Cat' }] });
    expect(r.ok).toBe(false);
  });

  it('exports the known field types list', () => {
    expect(KNOWN_FIELD_TYPES).toContain('text');
    expect(KNOWN_FIELD_TYPES).toContain('url');
    expect(KNOWN_FIELD_TYPES).toContain('text[]');
  });

  it('rejects more than one is_url field', () => {
    const r = validateMetaSchema({ fields: [
      { key: 'a', type: 'url', required: true, display: 'primary', label: 'A', is_url: true },
      { key: 'b', type: 'url', required: true, display: 'primary', label: 'B', is_url: true },
    ]});
    expect(r.ok).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/at most one field may have is_url/i);
  });

  it('accepts a single is_url field', () => {
    const r = validateMetaSchema({ fields: [
      { key: 'project_name', type: 'text', required: true, display: 'primary', label: 'P' },
      { key: 'live_demo', type: 'url', required: true, display: 'primary', label: 'L', is_url: true },
    ]});
    expect(r.ok).toBe(true);
  });
});

describe('getUrlFieldKey', () => {
  it('returns the key of the field marked is_url', () => {
    expect(getUrlFieldKey({ fields: [
      { key: 'x', type: 'text', required: true, display: 'primary', label: 'X' },
      { key: 'live', type: 'url', required: true, display: 'primary', label: 'L', is_url: true },
    ]})).toBe('live');
  });

  it('returns null when no field is marked', () => {
    expect(getUrlFieldKey({ fields: [
      { key: 'demo_url', type: 'url', required: true, display: 'primary', label: 'D' },
    ]})).toBe(null);
  });
});

describe('validateSubmissionData', () => {
  const schema = { fields: [
    { key: 'project_name', type: 'text' as const, required: true,  display: 'primary' as const, label: 'P' },
    { key: 'demo_url',     type: 'url'  as const, required: true,  display: 'primary' as const, label: 'D' },
    { key: 'team',         type: 'text[]' as const, required: false, display: 'detail' as const, label: 'T' },
  ]};

  it('accepts a valid submission', () => {
    const r = validateSubmissionData(schema, { project_name: 'X', demo_url: 'https://x.dev' });
    expect(r.ok).toBe(true);
  });

  it('rejects missing required field', () => {
    const r = validateSubmissionData(schema, { demo_url: 'https://x.dev' });
    expect(r.ok).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/project_name/);
  });

  it('rejects bad URL', () => {
    const r = validateSubmissionData(schema, { project_name: 'X', demo_url: 'not-a-url' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown keys (strict mode)', () => {
    const r = validateSubmissionData(schema, { project_name: 'X', demo_url: 'https://x.dev', stowaway: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/stowaway/);
  });

  it('accepts text[] arrays', () => {
    const r = validateSubmissionData(schema, { project_name: 'X', demo_url: 'https://x.dev', team: ['a','b'] });
    expect(r.ok).toBe(true);
  });
});
