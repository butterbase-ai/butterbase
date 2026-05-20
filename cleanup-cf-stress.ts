/**
 * Delete all Cloudflare Pages projects matching bb-stress-* and their
 * orphaned DNS records (stress-test-*.butterbase.dev CNAME records).
 *
 * Usage:
 *   npx tsx cleanup-cf-stress.ts --account-id <ID> --api-token <TOKEN> --zone-id <ZONE>
 *   npx tsx cleanup-cf-stress.ts --dry-run
 *
 * Environment variables (alternative to flags):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID
 */

const args = process.argv.slice(2);

function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return args[idx + 1];
}

const dryRun = args.includes('--dry-run');
const accountId = args.includes('--account-id') ? getArg('account-id') : process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = args.includes('--api-token') ? getArg('api-token') : process.env.CLOUDFLARE_API_TOKEN;
const zoneId = args.includes('--zone-id') ? getArg('zone-id') : process.env.CLOUDFLARE_ZONE_ID;

if (!accountId || !apiToken) {
  console.error('Provide CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars, or --account-id / --api-token flags');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;
const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

// ── Pages project cleanup ───────────────────────────────────────────

interface CfProject {
  name: string;
  created_on: string;
}

interface CfListResponse {
  result: CfProject[];
  result_info: { page: number; total_pages: number };
  success: boolean;
}

async function listStressProjects(): Promise<string[]> {
  const names: string[] = [];
  let page = 1;

  while (true) {
    const url = page === 1 ? BASE : `${BASE}?page=${page}`;
    const res = await fetch(url, { headers });
    const data = (await res.json()) as CfListResponse;

    if (!data.success || !Array.isArray(data.result)) {
      console.error('Unexpected API response:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    for (const p of data.result) {
      if (p.name.startsWith('bb-stress-')) {
        names.push(p.name);
      }
    }

    if (page >= data.result_info.total_pages) break;
    page++;
  }

  return names;
}

async function deleteCustomDomains(projectName: string): Promise<void> {
  const url = `${BASE}/${encodeURIComponent(projectName)}/domains`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { result: { id: string; name: string }[]; success: boolean };
    if (!data.success || !Array.isArray(data.result)) return;

    for (const domain of data.result) {
      process.stdout.write(`\n    Removing domain ${domain.name}...`);
      const delRes = await fetch(`${url}/${domain.name}`, { method: 'DELETE', headers });
      const delData = (await delRes.json()) as { success: boolean };
      process.stdout.write(delData.success ? ' OK' : ' FAILED');
    }
  } catch {
    // No domains or unexpected response — continue to project delete
  }
}

async function deleteProject(name: string): Promise<boolean> {
  // Must delete custom domains before the project
  await deleteCustomDomains(name);

  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { success: boolean; errors?: { code: number; message: string }[] };
    if (!data.success && data.errors?.length) {
      console.error(`\n    Error: ${data.errors.map(e => e.message).join(', ')}`);
    }
    return data.success;
  } catch {
    console.error(`\n    Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    return false;
  }
}

// ── DNS record cleanup ──────────────────────────────────────────────

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

interface DnsListResponse {
  result: DnsRecord[];
  result_info: { page: number; total_pages: number; total_count: number };
  success: boolean;
}

async function listStressDnsRecords(): Promise<DnsRecord[]> {
  if (!zoneId) return [];

  const zoneUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
  const records: DnsRecord[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      type: 'CNAME',
      search: 'stress-test-',
      page: String(page),
      per_page: '100',
    });
    const res = await fetch(`${zoneUrl}?${params}`, { headers });
    const data = (await res.json()) as DnsListResponse;

    if (!data.success || !Array.isArray(data.result)) break;

    for (const r of data.result) {
      if (r.name.startsWith('stress-test-')) {
        records.push(r);
      }
    }

    if (page >= data.result_info.total_pages) break;
    page++;
  }

  return records;
}

async function deleteDnsRecord(record: DnsRecord): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`;
  const res = await fetch(url, { method: 'DELETE', headers });
  const data = (await res.json()) as { success: boolean };
  return data.success;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // 1. Clean up Pages projects
  console.log('Fetching Cloudflare Pages projects...');
  const projects = await listStressProjects();
  console.log(`Found ${projects.length} bb-stress-* projects`);

  if (dryRun) {
    for (const name of projects) console.log(`  [dry-run] would delete project: ${name}`);
  } else {
    let deleted = 0;
    for (const name of projects) {
      process.stdout.write(`  Deleting ${name}...`);
      const ok = await deleteProject(name);
      console.log(ok ? ' OK' : ' FAILED');
      if (ok) deleted++;
    }
    console.log(`\nPages cleanup done. Deleted ${deleted}/${projects.length}`);
  }

  // 2. Clean up orphaned DNS records
  if (!zoneId) {
    console.log('\nSkipping DNS cleanup — no CLOUDFLARE_ZONE_ID / --zone-id provided.');
    return;
  }

  console.log('\nFetching stress-test-* DNS records...');
  const dnsRecords = await listStressDnsRecords();
  console.log(`Found ${dnsRecords.length} stress-test-* CNAME records`);

  if (dryRun) {
    for (const r of dnsRecords) console.log(`  [dry-run] would delete DNS: ${r.name} → ${r.content}`);
  } else {
    let deleted = 0;
    for (const r of dnsRecords) {
      process.stdout.write(`  Deleting DNS ${r.name}...`);
      const ok = await deleteDnsRecord(r);
      console.log(ok ? ' OK' : ' FAILED');
      if (ok) deleted++;
    }
    console.log(`\nDNS cleanup done. Deleted ${deleted}/${dnsRecords.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
