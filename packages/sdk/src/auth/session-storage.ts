/**
 * Interface for session persistence backends.
 * Matches the Web Storage API (getItem/setItem/removeItem) so any
 * Storage-compatible object works directly.
 */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * localStorage adapter. Default for browser environments.
 */
export class LocalSessionStorage implements SessionStorage {
  getItem(key: string): string | null {
    return localStorage.getItem(key);
  }
  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  }
  removeItem(key: string): void {
    localStorage.removeItem(key);
  }
}

/**
 * In-memory fallback for SSR / Node / environments where
 * localStorage is unavailable.
 */
export class MemorySessionStorage implements SessionStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

/**
 * Detect the best available storage. Returns LocalSessionStorage
 * when localStorage is functional, otherwise MemorySessionStorage.
 */
export function detectSessionStorage(): SessionStorage {
  try {
    const testKey = '__butterbase_storage_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    return new LocalSessionStorage();
  } catch {
    return new MemorySessionStorage();
  }
}
