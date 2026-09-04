import { useEffect } from 'react';
import { bb } from './butterbase';
import { FLAGS, isFlagEnabled } from './featureFlags';

// Public app id of the hosted butter-support service tickets land in.
// (Not our CRM app id — this is butterbase's support tenant.)
const SUPPORT_APP_ID = 'app_0ycj4ad7odud';
const SCRIPT_SRC = 'https://butter-support.butterbase.dev/widget.js';
const SCRIPT_ID = 'butter-support-widget-script';

type ButterSupportCall =
  | ['identify', { user_id: string; email?: string; name?: string }]
  | ['reset']
  | ['open']
  | ['close']
  | ['toggle'];

interface ButterSupportApi {
  q?: ButterSupportCall[];
  identify?: (u: { user_id: string; email?: string; name?: string }) => void;
  reset?: () => void;
  open?: () => void;
  close?: () => void;
  toggle?: () => void;
}

declare global {
  interface Window {
    ButterSupport?: ButterSupportApi;
  }
}

function call(...args: ButterSupportCall) {
  const w = window.ButterSupport ?? (window.ButterSupport = { q: [] });
  const [method, ...rest] = args;
  const fn = (w as any)[method];
  if (typeof fn === 'function') fn(...rest);
  else (w.q ??= []).push(args);
}

// Feature-flagged — see ./featureFlags.ts for the toggle commands.
export function SupportWidget() {
  useEffect(() => {
    if (!isFlagEnabled(FLAGS.supportWidget)) return;
    let cancelled = false;

    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.dataset.appId = SUPPORT_APP_ID;
      document.head.appendChild(script);
    }

    async function syncIdentity() {
      const { data: user } = await bb.auth.getUser();
      if (cancelled) return;
      if (!user) {
        call('reset');
        return;
      }
      const u = user as { id: string; email?: string; display_name?: string };
      call('identify', {
        user_id: u.id,
        email: u.email,
        name: u.display_name,
      });
    }

    syncIdentity();
    const sub: any = bb.onAuthStateChange?.(() => syncIdentity());
    return () => {
      cancelled = true;
      sub?.data?.subscription?.unsubscribe?.();
      sub?.unsubscribe?.();
    };
  }, []);

  return null;
}
