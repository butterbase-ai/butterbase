export interface PlatformDbConfig {
  primaryUrl: string;
  standbyUrl: string;
  activeSide: 'primary' | 'standby';
}

export function resolveActivePlatformDbUrl(cfg: PlatformDbConfig): string {
  if (cfg.activeSide === 'standby') {
    if (!cfg.standbyUrl) {
      throw new Error(
        'PLATFORM_DB_ACTIVE_SIDE=standby but NEON_PLATFORM_STANDBY_URL is empty. Set the standby URL or revert active side to primary.'
      );
    }
    return cfg.standbyUrl;
  }
  if (!cfg.primaryUrl) {
    throw new Error(
      'NEON_PLATFORM_PRIMARY_URL (or fallback CONTROL_DB_URL) is empty. Set a platform DB connection string.'
    );
  }
  return cfg.primaryUrl;
}
