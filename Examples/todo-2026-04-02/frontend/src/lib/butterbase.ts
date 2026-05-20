import { createClient } from '@butterbase/sdk';

const appId = import.meta.env.VITE_APP_ID;
const apiUrl = import.meta.env.VITE_API_BASE_URL;

if (!appId || !apiUrl) {
  throw new Error('Missing VITE_APP_ID or VITE_API_BASE_URL environment variables');
}

export const butterbase = createClient({
  appId,
  apiUrl,
  onUnauthorized: () => {
    localStorage.removeItem('token');
    window.location.href = '/login';
  },
});
