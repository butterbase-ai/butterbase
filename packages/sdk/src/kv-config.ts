export type KvRole = 'public' | 'authed' | 'owner' | 'deny';

export interface KvExposeRule {
  pattern: string;
  read: KvRole;
  write: KvRole;
}

export interface KvConfigInput {
  expose: KvExposeRule[];
}

export function defineKvConfig(config: KvConfigInput): KvConfigInput {
  return config;
}
