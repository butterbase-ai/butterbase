import { spawn } from 'node:child_process';
import { OfficeClient } from '@butterbase/sdk';
import { getMergedConfig, DEFAULT_ENDPOINT } from './config.js';

export async function createOfficeCliClient(organizationId: string): Promise<OfficeClient> {
  const config = await getMergedConfig();
  return new OfficeClient({ organizationId,
    apiUrl: process.env.BUTTERBASE_CONTROL_API_URL || config.endpoint || DEFAULT_ENDPOINT,
    getToken: async () => process.env.BUTTERBASE_API_KEY || (await getMergedConfig()).apiKey || '',
  });
}
/** Opt-in only; argv transport avoids shell interpolation of the receipt URL. */
export async function openOfficeConfirmation(value: string): Promise<void> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid confirmation URL.');
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.unref(); reject(new Error('Browser launcher did not finish.')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Browser launcher unavailable.')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Browser launcher failed.')); });
  });
}
