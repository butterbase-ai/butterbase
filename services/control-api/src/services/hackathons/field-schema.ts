import _Ajv, { type Ajv as AjvType, type ErrorObject, type ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';

// Ajv 8 ships an ESM/CJS dual package; under NodeNext the default import is wrapped.
type AjvCtor = new (opts?: ConstructorParameters<typeof AjvType>[0]) => AjvType;
const Ajv = ((_Ajv as unknown as { default?: AjvCtor }).default ?? (_Ajv as unknown as AjvCtor));
type AddFormats = (ajv: AjvType, options?: unknown) => AjvType;
const addFormats = ((_addFormats as unknown as { default?: AddFormats }).default ?? (_addFormats as unknown as AddFormats));

export const KNOWN_FIELD_TYPES = [
  'text', 'text[]', 'url', 'email', 'markdown', 'image_url', 'number', 'enum',
] as const;
export type FieldType = (typeof KNOWN_FIELD_TYPES)[number];

export type DisplayHint = 'primary' | 'detail' | 'private';

export interface FieldDef {
  key: string;
  type: FieldType;
  required: boolean;
  display: DisplayHint;
  label: string;
  /** Optional help text shown to participants and AI agents. */
  description?: string;
  options?: string[]; // required when type === 'enum'
  /** When true, submission `data[key]` is used for automated URL (host) scoring. At most one per schema. */
  is_url?: boolean;
}

export interface FieldSchema {
  fields: FieldDef[];
}

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const META_SCHEMA = {
  type: 'object',
  required: ['fields'],
  additionalProperties: false,
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'type', 'required', 'display', 'label'],
        additionalProperties: false,
        properties: {
          key:      { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          type:     { type: 'string', enum: [...KNOWN_FIELD_TYPES] },
          required: { type: 'boolean' },
          display:  { type: 'string', enum: ['primary', 'detail', 'private'] },
          label:    { type: 'string', minLength: 1 },
          description: { type: 'string' },
          options:  { type: 'array', items: { type: 'string' } },
          is_url:   { type: 'boolean' },
        },
      },
    },
  },
};

const metaValidator = ajv.compile(META_SCHEMA);

const PERSISTED_FIELD_KEYS = ['key', 'type', 'required', 'display', 'label', 'description', 'options', 'is_url'] as const;

/**
 * Strips unknown per-field keys and maps legacy `display: "always"` → `"primary"`.
 * Fills missing `display` when the rest of the field is otherwise complete so
 * older clients still round-trip.
 */
export function normalizeFieldSchemaInput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.fields)) return value;
  const fields = root.fields.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const f = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of PERSISTED_FIELD_KEYS) {
      if (f[k] !== undefined) out[k] = f[k];
    }
    if (out.display === 'always') out.display = 'primary';
    if (
      out.display === undefined &&
      typeof out.key === 'string' &&
      typeof out.type === 'string' &&
      typeof out.label === 'string' &&
      typeof out.required === 'boolean'
    ) {
      out.display = 'primary';
    }
    return out;
  });
  return { fields };
}

export function validateMetaSchema(value: unknown): ValidationResult {
  if (!metaValidator(value)) {
    return { ok: false, errors: (metaValidator.errors ?? []).map(formatError) };
  }
  const schema = value as unknown as FieldSchema;

  // Custom rules: duplicate keys, enum requires options.
  const seen = new Set<string>();
  const errors: string[] = [];
  let urlFieldCount = 0;
  for (const f of schema.fields) {
    if (seen.has(f.key)) errors.push(`duplicate field key: ${f.key}`);
    seen.add(f.key);
    if (f.type === 'enum' && (!f.options || f.options.length === 0)) {
      errors.push(`field ${f.key}: enum requires non-empty options[]`);
    }
    if (f.is_url === true) urlFieldCount += 1;
  }
  if (urlFieldCount > 1) {
    errors.push('at most one field may have is_url: true');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Key of the field marked for URL scoring, or null if none. */
export function getUrlFieldKey(schema: FieldSchema): string | null {
  const hit = schema.fields.find((f) => f.is_url === true);
  return hit ? hit.key : null;
}

const compiledCache = new WeakMap<FieldSchema, ValidateFunction>();

export function validateSubmissionData(schema: FieldSchema, data: unknown): ValidationResult {
  let cached = compiledCache.get(schema);
  if (!cached) {
    cached = ajv.compile(buildAjvSchemaFor(schema));
    compiledCache.set(schema, cached);
  }
  const validate: ValidateFunction = cached;
  if (!validate(data)) {
    return { ok: false, errors: (validate.errors ?? []).map(formatError) };
  }
  return { ok: true };
}

function buildAjvSchemaFor(schema: FieldSchema) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of schema.fields) {
    properties[f.key] = ajvFieldSchema(f);
    if (f.required) required.push(f.key);
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function ajvFieldSchema(f: FieldDef): Record<string, unknown> {
  switch (f.type) {
    case 'text':      return { type: 'string', minLength: 1 };
    case 'markdown':  return { type: 'string' };
    case 'url':       return { type: 'string', format: 'uri', pattern: '^https?://' };
    case 'email':     return { type: 'string', format: 'email' };
    case 'image_url': return { type: 'string', format: 'uri', pattern: '^https?://' };
    case 'number':    return { type: 'number' };
    case 'text[]':    return { type: 'array', items: { type: 'string' } };
    case 'enum':      return { type: 'string', enum: f.options ?? [] };
  }
}

function formatError(e: ErrorObject): string {
  const params = (e.params ?? {}) as Record<string, unknown>;
  if (e.keyword === 'required') {
    const k = params.missingProperty;
    return `field '${k}' is required`;
  }
  if (e.keyword === 'additionalProperties') {
    const k = params.additionalProperty;
    return `unknown field '${k}'`;
  }
  if (e.keyword === 'enum') {
    const allowed = Array.isArray(params.allowedValues) ? params.allowedValues.join(', ') : '';
    const path = e.instancePath || '<root>';
    return `${path} must be one of: ${allowed}`;
  }
  const path = e.instancePath || '<root>';
  return `${path} ${e.message ?? ''}`.trim();
}
