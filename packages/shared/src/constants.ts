export const APP_ID_PREFIX = 'app_';
export const APP_ID_LENGTH = 12;
export const APP_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export const API_KEY_PREFIX = 'bb_sk_';
// Substrate-scoped keys live in the same api_keys table but use a distinct
// prefix so the auth plugin's bb_sub_ passthrough and the substrate overlay's
// Path A gate can route them correctly.
export const API_KEY_SUBSTRATE_PREFIX = 'bb_sub_';
export const API_KEY_RANDOM_LENGTH = 40;
export const API_KEY_DISPLAY_LENGTH = 12;

export const DEFAULT_CONTROL_API_PORT = 3000;
export const DEFAULT_PGBOUNCER_PORT = 6432;

export const AUTH_SERVICE_PORT = 4200;
export const ACCESS_TOKEN_TTL = '1h'; // Changed from 15m to 1 hour
export const REFRESH_TOKEN_TTL_DAYS = 7;
export const BCRYPT_COST = 12;
export const JWT_ISSUER_PREFIX = 'butterbase:app:';

export const DEFAULT_POOL_SIZE = 20;
export const ADMIN_POOL_SIZE = 3;
