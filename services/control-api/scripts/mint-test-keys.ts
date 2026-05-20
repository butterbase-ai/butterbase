/**
 * One-off script: mint test API keys for gateway live tests.
 * Usage: npx tsx mint-test-keys.ts
 */
import pg from 'pg';
import { ApiKeyService } from '../src/services/api-key-service.js';

const DB_URL = process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const USER_ID = '00000000-0000-0000-0000-000000000001';

const pool = new pg.Pool({ connectionString: DB_URL });

// Stub out Redis so ApiKeyService.generateApiKey doesn't fail
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const { key: gatewayKey } = await ApiKeyService.generateApiKey(pool, USER_ID, 'test-gateway', ['ai:gateway']);
console.log('GATEWAY_KEY=' + gatewayKey);

const { key: wrongScopeKey } = await ApiKeyService.generateApiKey(pool, USER_ID, 'test-wrong-scope', ['some:other:scope']);
console.log('WRONG_SCOPE_KEY=' + wrongScopeKey);

await pool.end();
