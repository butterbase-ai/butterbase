import { createClient } from '@butterbase/sdk';

export const bb = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID!,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL!,
});

/**
 * Thin wrapper around bb.functions.invoke that normalises the {data,error}
 * shape and unwraps function-level error payloads. Use for any frontend write
 * that should go through a serverless function (e.g. crm-upsert-company /
 * crm-upsert-person — these enqueue substrate_outbox synchronously so UI edits
 * propagate to the user's substrate without waiting on the reconciler cron).
 */
export async function bbInvoke<T = any>(
  name: string,
  body: any,
): Promise<{ data: T | null; error: any }> {
  try {
    const res = await bb.functions.invoke<T>(name, { body });
    // ButterbaseResponse already has { data, error }; surface non-2xx bodies
    // that the SDK passed through as data.
    if ((res as any).error) return { data: null, error: (res as any).error };
    return { data: (res as any).data ?? null, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Single-row upsert keyed by an equality filter (typically the table's unique key).
 * Idempotent at the per-call level — racing writers can still collide, in which case
 * the second insert errors; that's fine for the workspace-scoped settings rows this
 * is meant for.
 *
 * Example: upsertRow('custom_fields', { id }, { id, name: 'Priority' })
 */
export async function upsertRow<T extends Record<string, any>>(
  table: string,
  match: Partial<T>,
  values: Partial<T>,
): Promise<T> {
  const matchEntries = Object.entries(match);
  if (matchEntries.length === 0) {
    throw new Error('upsertRow: match cannot be empty');
  }

  const sel: any = bb.from(table).select('*');
  for (const [k, v] of matchEntries) sel.eq(k, v);
  const { data: existing, error: selErr } = await sel.maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const upd: any = bb.from(table).update(values as any);
    for (const [k, v] of matchEntries) upd.eq(k, v);
    const { data, error } = await upd;
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? { ...existing, ...values }) as T;
  }

  const { data, error } = await bb
    .from(table)
    .insert({ ...match, ...values } as any)
    .select('*');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? { ...match, ...values }) as T;
}
