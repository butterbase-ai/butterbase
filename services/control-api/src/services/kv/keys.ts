const ALLOWED_KEY_RE = /^[A-Za-z0-9:_\-./]+$/;
const MAX_KEY_BYTES = 512;

export function userKey(appId: string, key: string): string {
  return `{${appId}}:u:${key}`;
}

export function isValidUserKey(key: string): boolean {
  if (key.length === 0) return false;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return false;
  if (key.startsWith('_')) return false;
  return ALLOWED_KEY_RE.test(key);
}

export function parseUserKey(stored: string): { appId: string; userKey: string } | null {
  const m = /^\{([^}]+)\}:u:(.+)$/.exec(stored);
  if (!m) return null;
  return { appId: m[1], userKey: m[2] };
}
