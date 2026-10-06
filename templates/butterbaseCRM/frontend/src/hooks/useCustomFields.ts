import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { listEntities, getEntity, updateEntityMerge } from '@/lib/substrate';
import type { SubstrateEntityType } from '@/lib/substrate';
import type { CustomField, CustomFieldValue, ObjectTypeSlug } from '@/lib/types';

const OBJECT_TYPE_TO_SUBSTRATE: Record<ObjectTypeSlug, SubstrateEntityType> = {
  people: 'person',
  companies: 'company',
  deals: 'project',
  meetings: 'event',
};

export function useCustomFields(objectType: ObjectTypeSlug) {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.customFields(ws, objectType),
    queryFn: async () => {
      const { data, error } = await bb.from<CustomField>('custom_fields')
        .select('*')
        .eq('workspace_id', ws)
        .eq('object_type', objectType)
        .order('position', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomField[];
    },
    enabled: !!ws,
  });
}

export function useCreateCustomField() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CustomField, 'id' | 'workspace_id' | 'created_at' | 'updated_at'>) => {
      const { data, error } = await bb.from<CustomField>('custom_fields')
        .insert({ ...input, workspace_id: ws })
        .select();
      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as CustomField;
    },
    onSuccess: (row) => qc.invalidateQueries({ queryKey: qk.customFields(ws, row.object_type) }),
  });
}

export function useDeleteCustomField() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('custom_fields').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customFields', ws] }),
  });
}

// All values for one object_type (cheap — small N for now). Returns a map
// keyed by entity_id → field_id → value (typed by kind).
//
// Meetings have been migrated to substrate entities (type='event') and their
// custom field values now live in entity.attrs.custom_fields. For object_type
// === 'meetings' we fetch from substrate and synthesize CustomFieldValue rows
// so the rest of the hook surface (valueFromRow, the lookup Map) stays the
// same. All other object types still hit the CRM `custom_field_values` table.
// Custom field values for people/companies/deals/meetings all live in
// substrate `entity.attrs.custom_fields`. We synthesize CustomFieldValue rows
// so the rest of the hook surface (valueFromRow, the lookup Map) stays unchanged.
export function useCustomFieldValues(objectType: ObjectTypeSlug) {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.customFieldValues(ws, objectType),
    queryFn: async () => {
      const substrateType = OBJECT_TYPE_TO_SUBSTRATE[objectType];
      const entities = await listEntities(substrateType, { limit: 200 });
      const rows: CustomFieldValue[] = [];
      for (const e of entities) {
        if (e.attrs?.deleted_at) continue;
        const cf = (e.attrs?.custom_fields ?? {}) as Record<string, unknown>;
        for (const [field_id, raw] of Object.entries(cf)) {
          if (raw === null || raw === undefined) continue;
          // Pack into all kind-specific columns — valueFromRow keys off
          // field.kind, so packing redundantly lets us avoid threading the
          // fields list through this query.
          rows.push({
            id: `${e.id}::${field_id}`,
            workspace_id: ws,
            field_id,
            object_type: objectType,
            entity_id: e.id,
            value_text: typeof raw === 'string' ? raw : raw == null ? null : String(raw),
            value_number: typeof raw === 'number' ? raw : (raw != null && !isNaN(Number(raw)) ? Number(raw) : null),
            value_bool: typeof raw === 'boolean' ? raw : null,
            value_date: typeof raw === 'string' ? raw : null,
            value_json: (raw && typeof raw === 'object') ? raw : null,
          } as unknown as CustomFieldValue);
        }
      }
      return rows;
    },
    enabled: !!ws,
  });
}

export function valueFromRow(v: CustomFieldValue | undefined, fields: CustomField[]): unknown {
  if (!v) return null;
  const f = fields.find((x) => x.id === v.field_id);
  if (!f) return null;
  switch (f.kind) {
    case 'number': return v.value_number;
    case 'date': return v.value_date;
    case 'checkbox': return v.value_bool;
    case 'select':
    case 'multiselect': return v.value_json;
    case 'text':
    case 'url':
    default: return v.value_text;
  }
}

export function patchForKind(kind: string, value: unknown): Partial<CustomFieldValue> {
  switch (kind) {
    case 'number': return { value_number: value == null ? null : Number(value) };
    case 'date': return { value_date: value == null ? null : String(value) };
    case 'checkbox': return { value_bool: value == null ? null : Boolean(value) };
    case 'select':
    case 'multiselect': return { value_json: value ?? null } as any;
    case 'text':
    case 'url':
    default: return { value_text: value == null ? null : String(value) };
  }
}

// Coerce a raw custom-field value into the JSON-friendly shape we store inside
// substrate entity.attrs.custom_fields. Mirrors patchForKind but produces a
// single scalar/object value, since the substrate side has no per-kind columns.
function coerceForKind(kind: string, value: unknown): unknown {
  if (value == null) return null;
  switch (kind) {
    case 'number': return Number(value);
    case 'date': return String(value);
    case 'checkbox': return Boolean(value);
    case 'select':
    case 'multiselect': return value;
    case 'text':
    case 'url':
    default: return String(value);
  }
}

// All custom-field writes now go through substrate.attrs.custom_fields. We
// read-modify-write the map so key deletion (value == null) is representable.
export function useUpsertCustomFieldValue() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { field: CustomField; entity_id: string; value: unknown }) => {
      const { field, entity_id, value } = input;
      const current = await getEntity(entity_id);
      const cur = (current?.attrs?.custom_fields ?? {}) as Record<string, unknown>;
      const next = { ...cur };
      if (value == null) {
        delete next[field.id];
      } else {
        next[field.id] = coerceForKind(field.kind, value);
      }
      // updateEntityMerge does a shallow merge over the top-level attrs map,
      // so passing the whole replacement custom_fields object is correct.
      await updateEntityMerge(entity_id, { custom_fields: next });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.customFieldValues(ws, vars.field.object_type) });
      // The list queries for the underlying object type read substrate too —
      // invalidate so the cell re-renders with the new value.
      if (vars.field.object_type === 'meetings') {
        qc.invalidateQueries({ queryKey: qk.meetings(ws) });
      } else if (vars.field.object_type === 'people') {
        qc.invalidateQueries({ queryKey: qk.people(ws) });
      } else if (vars.field.object_type === 'companies') {
        qc.invalidateQueries({ queryKey: qk.companies(ws) });
      }
    },
  });
}

// Convenience: returns a lookup function for an entity's custom-field value by ref.
//
// For meetings, values are sourced from substrate entity.attrs.custom_fields
// (via useCustomFieldValues above). The fields list itself is still a
// workspace-scoped CRM row, so useCustomFields is unchanged.
export function useCustomValueLookup(objectType: ObjectTypeSlug) {
  const { data: fields } = useCustomFields(objectType);
  const { data: values } = useCustomFieldValues(objectType);
  return useMemo(() => {
    const fieldsArr = fields ?? [];
    const idx = new Map<string, CustomFieldValue>();
    for (const v of (values ?? [])) idx.set(`${v.entity_id}::${v.field_id}`, v);
    return {
      fields: fieldsArr,
      get(entityId: string, fieldId: string) {
        return valueFromRow(idx.get(`${entityId}::${fieldId}`), fieldsArr);
      },
    };
  }, [fields, values]);
}
