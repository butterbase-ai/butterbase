/**
 * Cleanup script for Workers for Platforms stress test artifacts.
 *
 * Deletes all user workers matching bb-stress-* from the given dispatch namespace,
 * and optionally deletes the namespace itself.
 *
 * Usage:
 *   npx tsx scripts/cleanup-wfp-stress.ts \
 *     --account-id <CF_ACCOUNT_ID> \
 *     --api-token <CF_API_TOKEN> \
 *     --namespace bb-stress-ns
 *
 *   npx tsx scripts/cleanup-wfp-stress.ts --dry-run --namespace bb-stress-ns
 *   npx tsx scripts/cleanup-wfp-stress.ts --namespace bb-stress-ns --delete-namespace
 *
 * Environment variables (alternative to flags):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 */

const args = process.argv.slice(2);

function getFlag(name: string, envKey?: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  if (envKey && process.env[envKey]) return process.env[envKey]!;
  return '';
}

const dryRun = args.includes('--dry-run');
const deleteNamespace = args.includes('--delete-namespace');
const accountId = getFlag('account-id', 'CLOUDFLARE_ACCOUNT_ID');
const apiToken = getFlag('api-token', 'CLOUDFLARE_API_TOKEN');
const namespace = getFlag('namespace') || 'bb-stress-ns';

if (!accountId || !apiToken) {
  console.error(
    'Provide CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN env vars, or --account-id / --api-token flags',
  );
  process.exit(1);
}

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const headers: HeadersInit = {
  Authorization: `Bearer ${apiToken}`,
  'Content-Type': 'application/json',
};

interface ScriptInfo {
  id: string;
  script_name?: string;
  created_on: string;
}

interface ListResponse {
  success: boolean;
  result: ScriptInfo[];
  result_info?: { page: number; total_pages: number; count: number; total_count: number };
  errors?: { code: number; message: string }[];
}

async function listStressWorkers(): Promise<string[]> {
  const names: string[] = [];
  let page = 1;

  while (true) {
    const url = `${CF_BASE}/workers/dispatch/namespaces/${namespace}/scripts?page=${page}&per_page=100`;
    const res = await fetch(url, { headers });
    const data = (await res.json()) as ListResponse;

    if (!data.success || !Array.isArray(data.result)) {
      if (data.errors?.some((e) => e.code === 10092 || e.message.includes('not found'))) {
        console.log(`Namespace "${namespace}" not found.`);
        return [];
      }
      console.error('Unexpected API response:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    for (const script of data.result) {
      const name = script.script_name ?? script.id;
      if (name.startsWith('bb-stress-')) {
        names.push(name);
      }
    }

    const totalPages = data.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }

  return names;
}

async function deleteWorker(name: string): Promise<boolean> {
  const url = `${CF_BASE}/workers/dispatch/namespaces/${namespace}/scripts/${name}`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers });
    if (res.ok || res.status === 404) return true;
    const body = await res.text();
    console.error(`  Failed to delete ${name} (${res.status}): ${body.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.error(`  Network error deleting ${name}: ${err}`);
    return false;
  }
}

async function deleteNamespaceFn(): Promise<boolean> {
  const url = `${CF_BASE}/workers/dispatch/namespaces/${namespace}`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`Listing bb-stress-* workers in namespace "${namespace}"...`);
  const workers = await listStressWorkers();
  console.log(`Found ${workers.length} stress workers`);

  if (workers.length === 0 && !deleteNamespace) {
    console.log('Nothing to clean up.');
    return;
  }

  if (dryRun) {
    for (const name of workers) {
      console.log(`  [dry-run] would delete: ${name}`);
    }
    if (deleteNamespace) {
      console.log(`  [dry-run] would delete namespace: ${namespace}`);
    }
    return;
  }

  const BATCH_SIZE = 20;
  let deleted = 0;

  for (let i = 0; i < workers.length; i += BATCH_SIZE) {
    const batch = workers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(deleteWorker));
    const batchOk = results.filter(Boolean).length;
    deleted += batchOk;
    process.stdout.write(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: deleted ${batchOk}/${batch.length}\n`,
    );
  }

  console.log(`\nWorker cleanup done. Deleted ${deleted}/${workers.length}`);

  if (deleteNamespace) {
    console.log(`\nDeleting namespace "${namespace}"...`);
    const ok = await deleteNamespaceFn();
    console.log(ok ? '  Namespace deleted.' : '  Failed to delete namespace (may have remaining scripts).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
