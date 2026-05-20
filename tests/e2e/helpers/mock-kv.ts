import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

const FILE = process.env.KV_LOCAL_FILE ?? '/tmp/butterbase-e2e-kv.json';

interface Store { [key: string]: string }

async function load(): Promise<Store> {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); }
  catch { return {}; }
}
async function save(store: Store): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(store, null, 2));
}

export const mockKv = {
  async put(key: string, value: string): Promise<void> {
    const s = await load(); s[key] = value; await save(s);
  },
  async get(key: string): Promise<string | null> {
    return (await load())[key] ?? null;
  },
  async delete(key: string): Promise<void> {
    const s = await load(); delete s[key]; await save(s);
  },
  reset(): void {
    try { fsSync.unlinkSync(FILE); } catch {}
  },
};
