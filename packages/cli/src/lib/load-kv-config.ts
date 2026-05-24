import { register } from 'tsx/esm/api';
import path from 'node:path';

export interface KvExposeRule {
  pattern: string;
  read: string;
  write: string;
}

export interface KvConfig {
  expose: KvExposeRule[];
}

/**
 * Load a user's kv.config.ts file via tsx and return the parsed KvConfig.
 * Registers the tsx ESM hook, imports the file, then unregisters the hook.
 */
export async function loadKvConfig(filePath: string): Promise<KvConfig> {
  const absPath = path.resolve(filePath);
  const unregister = register();
  try {
    // Dynamic import with tsx registered as hook — handles .ts files
    const mod = await import(absPath);
    // Handle CJS/ESM interop: tsx may double-wrap export default as mod.default.default
    const rawDefault = mod.default;
    const config = (rawDefault && !Array.isArray(rawDefault.expose) && rawDefault.default)
      ? rawDefault.default
      : rawDefault;
    if (!config || !Array.isArray(config.expose)) {
      throw new Error(
        `${filePath} must export a default value from defineKvConfig({ expose: [...] })`,
      );
    }
    return config;
  } finally {
    await unregister();
  }
}
