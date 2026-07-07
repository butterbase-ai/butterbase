import { createClient } from '@butterbase/client'

export const bb = createClient({
  appId: import.meta.env.VITE_APP_ID,
  apiUrl: import.meta.env.VITE_API_URL,
})
