import fs from 'fs-extra';
import path from 'path';
import os from 'os';

export const DEFAULT_ENDPOINT = 'https://api.butterbase.ai';

export interface ButterbaseConfig {
  endpoint: string;
  apiKey?: string;
  currentApp?: string;
  apps?: Record<string, {
    id: string;
    name: string;
    apiUrl: string;
  }>;
  /** Set in the per-folder .butterbase/config.json by `butterbase repo init`/push/pull. */
  pinned_snapshot_id?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.butterbase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROJECT_CONFIG_FILE = '.butterbase/config.json';

/**
 * Get the global config file path
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
  await fs.ensureDir(CONFIG_DIR);
}

/**
 * Load global configuration
 */
export async function loadConfig(): Promise<ButterbaseConfig> {
  await ensureConfigDir();

  if (await fs.pathExists(CONFIG_FILE)) {
    return await fs.readJson(CONFIG_FILE);
  }

  // Return default config
  return {
    endpoint: DEFAULT_ENDPOINT,
  };
}

/**
 * Save global configuration
 */
export async function saveConfig(config: ButterbaseConfig): Promise<void> {
  await ensureConfigDir();
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
}

/**
 * Update a specific config value
 */
export async function updateConfig(key: keyof ButterbaseConfig, value: any): Promise<void> {
  const config = await loadConfig();
  config[key] = value;
  await saveConfig(config);
}

/**
 * Load project-level configuration (from current directory)
 */
export async function loadProjectConfig(): Promise<Partial<ButterbaseConfig> | null> {
  if (await fs.pathExists(PROJECT_CONFIG_FILE)) {
    return await fs.readJson(PROJECT_CONFIG_FILE);
  }
  return null;
}

/**
 * Save project-level configuration
 */
export async function saveProjectConfig(config: Partial<ButterbaseConfig>): Promise<void> {
  await fs.ensureDir(path.dirname(PROJECT_CONFIG_FILE));
  await fs.writeJson(PROJECT_CONFIG_FILE, config, { spaces: 2 });
}

let localhostWarned = false;

function warnIfLocalEndpoint(endpoint: string | undefined): void {
  if (localhostWarned || !endpoint) return;
  try {
    const h = new URL(endpoint).hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') {
      localhostWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[butterbase] endpoint is ${endpoint} (local). Run \`butterbase config set endpoint ${DEFAULT_ENDPOINT}\` to use the hosted platform.`
      );
    }
  } catch {}
}

/**
 * Get merged configuration (project overrides global)
 */
export async function getMergedConfig(): Promise<ButterbaseConfig> {
  const globalConfig = await loadConfig();
  const projectConfig = await loadProjectConfig();

  const merged = projectConfig ? { ...globalConfig, ...projectConfig } : globalConfig;
  warnIfLocalEndpoint(merged.endpoint);
  return merged;
}

/**
 * Get the current app ID from config
 */
export async function getCurrentAppId(): Promise<string | undefined> {
  const config = await getMergedConfig();
  return config.currentApp;
}

/**
 * Set the current app ID
 */
export async function setCurrentAppId(appId: string): Promise<void> {
  await updateConfig('currentApp', appId);
}

/**
 * Get the API key from config
 */
export async function getApiKey(): Promise<string | undefined> {
  const config = await getMergedConfig();
  return config.apiKey;
}

/**
 * Get the API URL from config
 */
export async function getApiUrl(): Promise<string> {
  const config = await getMergedConfig();
  return config.endpoint ?? DEFAULT_ENDPOINT;
}

/** Read the per-folder pinned snapshot id, or null when not bound or never synced. */
export async function getPinnedSnapshotId(): Promise<string | null> {
  const proj = await loadProjectConfig();
  return (proj?.pinned_snapshot_id as string | undefined) ?? null;
}

/** Update the per-folder pinned snapshot id. Creates the project config if missing. */
export async function setPinnedSnapshotId(snapshotId: string | null): Promise<void> {
  const existing = (await loadProjectConfig()) ?? {};
  if (snapshotId === null) {
    delete (existing as any).pinned_snapshot_id;
  } else {
    (existing as any).pinned_snapshot_id = snapshotId;
  }
  await saveProjectConfig(existing);
}

/** Read the bound app id from the per-folder config (not from the global currentApp). */
export async function getBoundAppId(): Promise<string | null> {
  const proj = await loadProjectConfig();
  return (proj?.currentApp as string | undefined) ?? null;
}
