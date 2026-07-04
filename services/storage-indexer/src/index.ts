import { neon } from '@neondatabase/serverless';

interface Env {
  STORAGE_BUCKET: R2Bucket;
  // Control plane DB — holds the cross-region org_app_index used to find
  // each app's home region.
  CONTROL_DB_URL: string;
  // Comma-separated list of configured regions (e.g. "us-east-1,us-west-2").
  // The indexer iterates this list to validate that the resolved home region
  // has a matching runtime DB URL.
  BUTTERBASE_REGIONS: string;
  // Per-region runtime DB URLs. Wrangler maps these as plain vars/secrets
  // named NEON_RUNTIME_PROJECT_ID_<REGION_UPPER_UNDERSCORED>, mirroring the
  // env shape used by services/control-api/src/services/runtime-db.ts.
  [key: string]: unknown;
}

interface R2EventMessage {
  account: string;
  bucket: string;
  object: {
    key: string;
    size: number;
    eTag: string;
  };
  action: string;
  eventTime: string;
}

interface ObjectMetadata {
  appId: string;
  userId: string;
  filename: string;
}

// Butterbase app ids: lowercase `app_` prefix + 12 base36 chars (see
// generateAppId in services/control-api/src/services/provisioner.ts).
// Tolerate longer ids defensively.
const APP_ID_REGEX = /^app_[a-z0-9]{6,}$/;
// User ids are UUID v4 (platform_users.id from CF SaaS).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Build pipeline writes to the same bucket but under reserved prefixes that
// are not user uploads (source zips, build artifacts, build logs, npm cache).
// They are not indexed and must not produce error logs.
const BUILD_PIPELINE_PREFIXES = ['source/', 'artifact/', 'logs/', 'cache/'];

function isBuildPipelineKey(key: string): boolean {
  return BUILD_PIPELINE_PREFIXES.some((p) => key.startsWith(p));
}

function parseObjectKey(key: string): ObjectMetadata | null {
  // Key format: {app_id}/{user_id}/{uuid}_{filename}
  const parts = key.split('/');
  if (parts.length < 3) return null;

  const [appId, userId, ...filenameParts] = parts;
  const fullFilename = filenameParts.join('/');

  if (!APP_ID_REGEX.test(appId)) {
    console.error(`Invalid appId format (expected "app_..."): ${appId}`);
    return null;
  }

  if (!UUID_REGEX.test(userId)) {
    console.error(`Invalid userId format (not a UUID): ${userId}`);
    return null;
  }

  // Extract original filename (after uuid_)
  const underscoreIndex = fullFilename.indexOf('_');
  const filename = underscoreIndex >= 0
    ? fullFilename.substring(underscoreIndex + 1)
    : fullFilename;

  return { appId, userId, filename };
}

function regionToEnvSuffix(region: string): string {
  return region.toUpperCase().replace(/-/g, '_');
}

/**
 * Looks up the app's home region via org_app_index on the control DB, then
 * returns the runtime-DB connection URL for that region. Returns null when
 * the app has no index entry (not yet provisioned, or already deleted).
 */
async function resolveRuntimeDbUrl(appId: string, env: Env): Promise<string | null> {
  const sql = neon(env.CONTROL_DB_URL);
  const rows = (await sql`
    SELECT region FROM org_app_index WHERE app_id = ${appId} LIMIT 1
  `) as Array<{ region: string }>;
  if (rows.length === 0) return null;
  const region = rows[0].region;
  const url = env[`NEON_RUNTIME_PROJECT_ID_${regionToEnvSuffix(region)}`] as string | undefined;
  if (!url) {
    console.error(`No runtime DB URL configured for region "${region}" (env NEON_RUNTIME_PROJECT_ID_${regionToEnvSuffix(region)})`);
    return null;
  }
  return url;
}

async function processEvent(
  msg: R2EventMessage,
  env: Env
): Promise<void> {
  const { bucket, object } = msg;
  const { key, size } = object;

  if (isBuildPipelineKey(key)) {
    return;
  }

  console.log(`Processing R2 event: bucket=${bucket}, key=${key}, size=${size}`);

  const metadata = parseObjectKey(key);
  if (!metadata) {
    console.error(`Invalid key format: ${key}`);
    return;
  }

  // Resolve the app's home runtime DB. storage_objects is a per-region
  // runtime-tier table — writing to the wrong region would silently orphan
  // the row from the app's data plane and break manage_storage list/download.
  const runtimeDbUrl = await resolveRuntimeDbUrl(metadata.appId, env);
  if (!runtimeDbUrl) {
    console.warn(`Skipping index: app ${metadata.appId} not in org_app_index`);
    return;
  }

  // Fetch object metadata from R2
  let contentType = 'application/octet-stream';
  let originalFilename = metadata.filename;

  try {
    const head = await env.STORAGE_BUCKET.head(key);
    if (head) {
      contentType = head.httpMetadata?.contentType || contentType;
      originalFilename = head.customMetadata?.['x-butterbase-original-filename'] || originalFilename;
    }
  } catch (error) {
    console.warn(`Failed to fetch object metadata for ${key}: ${error}`);
  }

  // Upsert into the app's home-region runtime DB.
  const sql = neon(runtimeDbUrl);

  // Resolve organization_id for this app
  const orgResult = await sql`SELECT organization_id FROM apps WHERE id = ${metadata.appId}`;
  if (orgResult.length === 0 || !orgResult[0].organization_id) {
    throw new Error(`Failed to resolve organization_id for app ${metadata.appId}`);
  }
  const organizationId = orgResult[0].organization_id;

  await sql`
    INSERT INTO storage_objects (id, app_id, organization_id, user_id, bucket, key, filename, content_type, size_bytes, created_at)
    VALUES (gen_random_uuid(), ${metadata.appId}, ${organizationId}, ${metadata.userId}, ${bucket}, ${key}, ${originalFilename}, ${contentType}, ${size}, now())
    ON CONFLICT (app_id, bucket, key) DO UPDATE SET
      size_bytes = EXCLUDED.size_bytes,
      content_type = EXCLUDED.content_type
  `;

  console.log(`Successfully indexed object: ${key} (app=${metadata.appId})`);
}

export default {
  async queue(
    batch: MessageBatch<R2EventMessage>,
    env: Env
  ): Promise<void> {
    console.log(`Received batch of ${batch.messages.length} R2 events`);

    for (const message of batch.messages) {
      try {
        await processEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error(`Failed to process event for key=${message.body.object.key}: ${error}`);
        message.retry();
      }
    }
  },
};
