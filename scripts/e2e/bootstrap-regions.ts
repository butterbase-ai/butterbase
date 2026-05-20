#!/usr/bin/env tsx
/**
 * Apply control + runtime + data migrations to every configured region.
 * Idempotent — re-running is safe. Also creates the move-app S3 / R2 bucket.
 *
 * Region identifiers are NEVER hardcoded in this script. All region names
 * come from BUTTERBASE_REGIONS; all URLs come from per-region env vars:
 *   NEON_RUNTIME_PROJECT_ID_<REGION_KEY>
 *   NEON_DATA_PROJECT_ID_<REGION_KEY>
 * where REGION_KEY is the region name uppercased with dashes → underscores
 * (e.g. "us-east-1" → "US_EAST_1"). This matches the convention used by
 * services/control-api/src/services/runtime-pool-registry.ts.
 *
 * Env-var notes (from inspecting the actual migrators):
 *   control-plane/migrate.ts  → reads NEON_PLATFORM_PRIMARY_URL or CONTROL_DB_URL
 *   runtime-plane/migrate.ts  → reads BUTTERBASE_REGIONS + NEON_RUNTIME_PROJECT_ID_<KEY>
 *   data-plane/migrate.ts     → CLI entry resolves .sql files only
 */
import { execSync } from 'node:child_process';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

function envKeyFor(region: string): string {
  return region.toUpperCase().replace(/-/g, '_');
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const REGIONS = (process.env.BUTTERBASE_REGIONS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (REGIONS.length === 0) {
  throw new Error('BUTTERBASE_REGIONS must be set (comma-separated region names)');
}

const CONTROL_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ?? process.env.CONTROL_DB_URL;
if (!CONTROL_URL) {
  throw new Error('NEON_PLATFORM_PRIMARY_URL or CONTROL_DB_URL must be set');
}

function run(label: string, cmd: string, env: Record<string, string>): void {
  console.log(`\n[${label}] $ ${cmd}`);
  execSync(cmd, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    cwd: new URL('../..', import.meta.url).pathname,
  });
}

async function ensureBucket(): Promise<void> {
  const bucket = process.env.MOVE_APP_DUMP_BUCKET ?? 'butterbase-move-dumps';
  const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: process.env.AWS_REGION ?? 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`\n[bucket] ${bucket} already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`\n[bucket] created ${bucket}`);
  }
}

async function main(): Promise<void> {
  console.log(`Bootstrapping regions: ${REGIONS.join(', ')}`);

  // 1. Control-plane migrations (single DB, region-agnostic)
  run('control', 'npx tsx db/control-plane/migrate.ts', {
    NEON_PLATFORM_PRIMARY_URL: CONTROL_URL,
    CONTROL_DB_URL: CONTROL_URL,
  });

  // 2. Runtime-plane migrations (per-region)
  for (const region of REGIONS) {
    const key = envKeyFor(region);
    const runtimeUrl = requiredEnv(`NEON_RUNTIME_PROJECT_ID_${key}`);
    run(`runtime/${region}`, 'npx tsx db/runtime-plane/migrate.ts', {
      BUTTERBASE_REGIONS: region,
      [`NEON_RUNTIME_PROJECT_ID_${key}`]: runtimeUrl,
    });
  }

  // 3. Data-plane migrations (per-region)
  for (const region of REGIONS) {
    const key = envKeyFor(region);
    const dataUrl = requiredEnv(`NEON_DATA_PROJECT_ID_${key}`);
    run(`data/${region}`, 'npx tsx db/data-plane/migrate.ts', {
      BUTTERBASE_REGIONS: region,
      [`NEON_DATA_PROJECT_ID_${key}`]: dataUrl,
      DATA_DB_URL: dataUrl,
    });
  }

  // 4. Ensure move-app dump bucket exists (R2/S3)
  if (process.env.R2_ENDPOINT) {
    await ensureBucket();
  } else {
    console.log('\n[bucket] R2_ENDPOINT unset; skipping bucket provision');
  }

  console.log('\n✓ All regions bootstrapped');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
