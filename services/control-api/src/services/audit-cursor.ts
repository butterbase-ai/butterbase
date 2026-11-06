export interface AuditCursor { createdAt: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Opaque keyset position. Never signed; it carries no authority, only a position. */
export function encodeAuditCursor(row: { created_at: string | Date; id: string }): string {
  const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(JSON.stringify({ v: 1, at, id: row.id })).toString('base64url');
}

/** Returns null for every malformed value; the route turns null into a 400. */
export function decodeAuditCursor(value: string): AuditCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { v, at, id } = parsed as { v?: unknown; at?: unknown; id?: unknown };
    if (v !== 1 || typeof at !== 'string' || !ISO.test(at) || !Number.isFinite(Date.parse(at))) return null;
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return { createdAt: at, id };
  } catch {
    return null;
  }
}
