// services/registry-facade/src/auth.ts
//
// Pure auth helpers for the registry facade. No I/O lives here; the worker
// wires these to the control-api auth-check call.

// Docker sends HTTP Basic auth (username:password). For Butterbase the password
// is a bb_sk_ key; the username is ignored (docker forces a non-empty username,
// users pass `app` or anything). Returns the key, or null if the header is
// missing/garbage or the password is not a bb_sk_ key.
export function parseBasicAuth(header: string | null): string | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const password = decoded.slice(idx + 1);
    return password.startsWith('bb_sk_') ? password : null;
  } catch {
    return null;
  }
}

// The repo path is `{app_id}/{name}`; keyAppId is the app the key's owner is
// authorized for (resolved by control-api). Push is allowed only when the
// repo's app segment matches exactly (the trailing slash prevents
// `app_abc` matching `app_abc123`).
export function checkRepoScope(repo: string, keyAppId: string): boolean {
  return repo.startsWith(`${keyAppId}/`);
}
