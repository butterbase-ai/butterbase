// Filter DSL — the shared shape used by the toolbar, saved views, and AI search.
//
// A Filter targets either a built-in column on the object's row, or a custom
// field (joined via custom_field_values at query time). The DSL is intentionally
// flat — chained filters are AND-ed.

import type { CustomField } from './types';

export type ObjectType = 'people' | 'companies' | 'deals' | 'meetings';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'    // ilike '%v%'
  | 'starts_with' // ilike 'v%'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'not_null'
  | 'in'
  | 'between';

export type FieldKind = 'text' | 'number' | 'date' | 'url' | 'checkbox' | 'select' | 'multiselect' | 'enum';

export interface FieldSpec {
  slug: string;       // column name for built-ins; custom field slug otherwise
  label: string;
  kind: FieldKind;
  builtIn: boolean;
  options?: string[]; // for enum / select
}

export interface Filter {
  field: string;       // slug; "cf:<custom_field_id>" for custom fields
  op: FilterOp;
  value?: unknown;
}

export interface SortSpec { field: string; direction: 'asc' | 'desc' }

// ─── Built-in field catalogs per object_type ──────────────────────────────

export const BUILTIN_FIELDS: Record<ObjectType, FieldSpec[]> = {
  people: [
    { slug: 'first_name', label: 'First name', kind: 'text', builtIn: true },
    { slug: 'last_name', label: 'Last name', kind: 'text', builtIn: true },
    { slug: 'email', label: 'Email', kind: 'text', builtIn: true },
    { slug: 'title', label: 'Title', kind: 'text', builtIn: true },
    { slug: 'phone', label: 'Phone', kind: 'text', builtIn: true },
    { slug: 'linkedin_url', label: 'LinkedIn', kind: 'url', builtIn: true },
    { slug: 'created_at', label: 'Created', kind: 'date', builtIn: true },
    { slug: 'updated_at', label: 'Last updated', kind: 'date', builtIn: true },
  ],
  companies: [
    { slug: 'name', label: 'Name', kind: 'text', builtIn: true },
    { slug: 'domain', label: 'Domain', kind: 'text', builtIn: true },
    { slug: 'industry', label: 'Industry', kind: 'text', builtIn: true },
    { slug: 'location', label: 'Location', kind: 'text', builtIn: true },
    { slug: 'employee_count', label: 'Employees', kind: 'number', builtIn: true },
    { slug: 'description', label: 'Description', kind: 'text', builtIn: true },
    { slug: 'linkedin_url', label: 'LinkedIn', kind: 'url', builtIn: true },
    { slug: 'created_at', label: 'Created', kind: 'date', builtIn: true },
    { slug: 'updated_at', label: 'Last updated', kind: 'date', builtIn: true },
  ],
  deals: [
    { slug: 'name', label: 'Name', kind: 'text', builtIn: true },
    { slug: 'stage', label: 'Stage', kind: 'enum', builtIn: true, options: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] },
    { slug: 'amount_cents', label: 'Amount (cents)', kind: 'number', builtIn: true },
    { slug: 'currency', label: 'Currency', kind: 'text', builtIn: true },
    { slug: 'close_date', label: 'Close date', kind: 'date', builtIn: true },
    { slug: 'created_at', label: 'Created', kind: 'date', builtIn: true },
    { slug: 'updated_at', label: 'Last updated', kind: 'date', builtIn: true },
  ],
  meetings: [
    { slug: 'title', label: 'Title', kind: 'text', builtIn: true },
    { slug: 'location', label: 'Location', kind: 'text', builtIn: true },
    { slug: 'starts_at', label: 'Starts', kind: 'date', builtIn: true },
    { slug: 'ends_at', label: 'Ends', kind: 'date', builtIn: true },
    { slug: 'created_at', label: 'Created', kind: 'date', builtIn: true },
  ],
};

export const OBJECT_TO_TABLE: Record<ObjectType, string> = {
  people: 'people',
  companies: 'companies',
  deals: 'deals',
  meetings: 'meetings',
};

// ─── Ops per kind ─────────────────────────────────────────────────────────

const TEXT_OPS: FilterOp[] = ['contains', 'starts_with', 'eq', 'neq', 'is_null', 'not_null'];
const NUM_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'];
const DATE_OPS: FilterOp[] = ['gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'];
const URL_OPS: FilterOp[] = ['contains', 'eq', 'neq', 'is_null', 'not_null'];
const BOOL_OPS: FilterOp[] = ['eq'];
const ENUM_OPS: FilterOp[] = ['eq', 'neq', 'in', 'is_null', 'not_null'];

export function opsForKind(kind: FieldKind): FilterOp[] {
  switch (kind) {
    case 'text': return TEXT_OPS;
    case 'number': return NUM_OPS;
    case 'date': return DATE_OPS;
    case 'url': return URL_OPS;
    case 'checkbox': return BOOL_OPS;
    case 'enum':
    case 'select':
    case 'multiselect': return ENUM_OPS;
  }
}

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  starts_with: 'starts with',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_null: 'is empty',
  not_null: 'is not empty',
  in: 'is one of',
  between: 'between',
};

// ─── Custom field helpers ─────────────────────────────────────────────────

export function customFieldToSpec(f: CustomField): FieldSpec {
  return {
    slug: customFieldRef(f.id),
    label: f.name,
    kind: f.kind as FieldKind,
    builtIn: false,
    options: (f.config as any)?.options,
  };
}

export function customFieldRef(id: string): string { return `cf:${id}`; }
export function parseCustomFieldRef(ref: string): string | null {
  return ref.startsWith('cf:') ? ref.slice(3) : null;
}

export function fieldsForObject(object_type: ObjectType, customs: CustomField[]): FieldSpec[] {
  const built = BUILTIN_FIELDS[object_type];
  const cf = customs
    .filter((c) => c.object_type === object_type)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(customFieldToSpec);
  return [...built, ...cf];
}

// ─── Apply filters to a SDK query builder (built-in only) ─────────────────
// Custom-field filters are handled separately via id-set intersection.

export interface QueryLike {
  eq(col: string, v: any): QueryLike;
  neq(col: string, v: any): QueryLike;
  gt(col: string, v: any): QueryLike;
  gte(col: string, v: any): QueryLike;
  lt(col: string, v: any): QueryLike;
  lte(col: string, v: any): QueryLike;
  ilike(col: string, v: any): QueryLike;
  is(col: string, v: any): QueryLike;
  not(col: string, op: string, v: any): QueryLike;
  in(col: string, v: any[]): QueryLike;
  order(col: string, opts?: any): QueryLike;
}

export function applyBuiltinFilter(q: QueryLike, f: Filter): QueryLike {
  if (parseCustomFieldRef(f.field)) return q; // skip — handled by id-set path
  const col = f.field;
  switch (f.op) {
    case 'eq': return q.eq(col, f.value);
    case 'neq': return q.neq(col, f.value);
    case 'gt': return q.gt(col, f.value);
    case 'gte': return q.gte(col, f.value);
    case 'lt': return q.lt(col, f.value);
    case 'lte': return q.lte(col, f.value);
    case 'contains': return q.ilike(col, `%${String(f.value ?? '')}%`);
    case 'starts_with': return q.ilike(col, `${String(f.value ?? '')}%`);
    case 'is_null': return q.is(col, null);
    case 'not_null': return q.not(col, 'is', null);
    case 'in': return q.in(col, Array.isArray(f.value) ? f.value : []);
    case 'between':
      if (Array.isArray(f.value) && f.value.length === 2) {
        return q.gte(col, f.value[0]).lte(col, f.value[1]);
      }
      return q;
  }
}

// Client-side filter for in-memory rows (used to apply custom-field-aware
// filters once we've joined the cfv rows).
export function rowMatches(row: any, f: Filter, customValueResolver?: (row: any, ref: string) => any): boolean {
  const cf = parseCustomFieldRef(f.field);
  const raw = cf && customValueResolver ? customValueResolver(row, f.field) : row?.[f.field];
  switch (f.op) {
    case 'eq': return raw === f.value;
    case 'neq': return raw !== f.value;
    case 'gt': return raw != null && Number(raw) > Number(f.value);
    case 'gte': return raw != null && Number(raw) >= Number(f.value);
    case 'lt': return raw != null && Number(raw) < Number(f.value);
    case 'lte': return raw != null && Number(raw) <= Number(f.value);
    case 'contains': return raw != null && String(raw).toLowerCase().includes(String(f.value ?? '').toLowerCase());
    case 'starts_with': return raw != null && String(raw).toLowerCase().startsWith(String(f.value ?? '').toLowerCase());
    case 'is_null': return raw == null || raw === '';
    case 'not_null': return raw != null && raw !== '';
    case 'in': return Array.isArray(f.value) && f.value.includes(raw);
    case 'between':
      if (!Array.isArray(f.value) || f.value.length !== 2 || raw == null) return false;
      return Number(raw) >= Number(f.value[0]) && Number(raw) <= Number(f.value[1]);
  }
}

export function formatFilterChip(f: Filter, fields: FieldSpec[]): string {
  const fs = fields.find((x) => x.slug === f.field);
  const label = fs?.label ?? f.field;
  const opLabel = OP_LABEL[f.op] ?? f.op;
  if (f.op === 'is_null' || f.op === 'not_null') return `${label} ${opLabel}`;
  if (f.op === 'between' && Array.isArray(f.value)) return `${label} ${opLabel} ${f.value[0]} – ${f.value[1]}`;
  if (f.op === 'in' && Array.isArray(f.value)) return `${label} ${opLabel} ${f.value.join(', ')}`;
  return `${label} ${opLabel} ${String(f.value ?? '')}`;
}
