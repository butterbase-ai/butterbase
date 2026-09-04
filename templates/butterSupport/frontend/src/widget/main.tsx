import { createRoot } from 'react-dom/client';
import { Widget } from './Widget';
import { APP_ID_FROM_ENV } from './lib';
import widgetCss from './styles.css?inline';

if (typeof document !== 'undefined' && !document.getElementById('butter-support-widget-styles')) {
  const style = document.createElement('style');
  style.id = 'butter-support-widget-styles';
  style.textContent = widgetCss;
  document.head.appendChild(style);
}

declare global {
  interface Window {
    __BUTTER_WIDGET_MOUNTED__?: boolean;
    ButterSupport?: any;
  }
}

function boot() {
  if (window.__BUTTER_WIDGET_MOUNTED__) return;

  const script = (document.currentScript as HTMLScriptElement | null) ||
    (document.querySelector('script[src*="widget.js"]') as HTMLScriptElement | null);
  const dataset = script?.dataset || ({} as DOMStringMap);

  const appId = dataset.appId || APP_ID_FROM_ENV;
  if (!appId) {
    console.error('[ButterSupport] no app id — set data-app-id on the script tag');
    return;
  }

  let root = document.getElementById('butter-support-widget');
  if (!root) {
    root = document.createElement('div');
    root.id = 'butter-support-widget';
    document.body.appendChild(root);
  }
  window.__BUTTER_WIDGET_MOUNTED__ = true;
  createRoot(root).render(<Widget appId={appId} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
