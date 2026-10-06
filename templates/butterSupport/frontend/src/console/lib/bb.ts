import { createClient } from '@butterbase/sdk';

// Runtime-first app id lookup. The zip-dist.js packager rewrites
// <meta name="butterbase-app-id" content="__BB_APP_ID__" /> in index.html at
// package time so the SAME dist/ folder can be deployed to every clone
// without a rebuild. Fall back to the build-time env for local dev, where the
// meta tag still holds the placeholder string.
function readAppId(): string {
  try {
    const el = typeof document !== 'undefined'
      ? document.querySelector<HTMLMetaElement>('meta[name="butterbase-app-id"]')
      : null;
    const v = el?.content?.trim();
    if (v && v !== '__BB_APP_ID__') return v;
  } catch { /* ignore — SSR or DOM unavailable */ }
  return (import.meta.env.VITE_BUTTERBASE_APP_ID as string) || '';
}

export const APP_ID = readAppId();
export const API_URL = import.meta.env.VITE_BUTTERBASE_API_URL as string;
export const SUBDOMAIN = import.meta.env.VITE_BUTTERBASE_SUBDOMAIN as string;

export const bb = createClient({
  appId: APP_ID,
  apiUrl: API_URL,
});

export async function getAccessToken(): Promise<string | null> {
  // SDK persists camelCase under butterbase.auth.<appId>; sessionManager.getSession() is the in-memory accessor.
  try {
    const session = (bb as any).sessionManager?.getSession?.();
    if (session?.accessToken) return session.accessToken as string;
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(`butterbase.auth.${APP_ID}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.accessToken ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}
