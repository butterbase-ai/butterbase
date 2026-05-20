import fs from 'fs-extra';
import path from 'path';
import os from 'os';

export interface ButterbaseConfig {
  endpoint: string;
  apiKey?: string;
  currentApp?: string;
  apps?: Record<string, {
    id: string;
    name: string;
    apiUrl: string;
  }>;
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
    endpoint: 'https://api.butterbase.ai',
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

/**
 * Get merged configuration (project overrides global)
 */
export async function getMergedConfig(): Promise<ButterbaseConfig> {
  const globalConfig = await loadConfig();
  const projectConfig = await loadProjectConfig();

  if (projectConfig) {
    return { ...globalConfig, ...projectConfig };
  }

  return globalConfig;
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
  return config.endpoint ?? 'https://api.butterbase.ai';
}
