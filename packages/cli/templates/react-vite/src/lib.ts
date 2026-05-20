import { createClient } from '@butterbase/sdk';

export const butterbase = createClient({
  appId: import.meta.env.VITE_APP_ID,
  apiUrl: import.meta.env.VITE_API_URL,
});
