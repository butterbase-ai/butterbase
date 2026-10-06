/**
 * Normalize a Butterbase data response.
 * The SDK returns { data: T | null, error: ... }; older / direct shapes
 * may already be an array. This helper handles both safely.
 */
export function rows<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res as T[];
  const d = res?.data;
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === 'object' && Array.isArray((d as any).rows)) return (d as any).rows as T[];
  return [];
}

export function row<T = any>(res: any): T | null {
  if (res && !Array.isArray(res) && !('data' in res) && typeof res === 'object') return res as T;
  const d = res?.data;
  if (Array.isArray(d)) return (d[0] as T) ?? null;
  if (d && typeof d === 'object') return d as T;
  return null;
}
