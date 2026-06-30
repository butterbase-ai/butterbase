import chalk from 'chalk';
import ora from 'ora';
import { createClient } from '@butterbase/sdk';
import { getMergedConfig, getCurrentAppId } from '../lib/config.js';
import type { PeopleMeta, ProfilePayload } from '@butterbase/sdk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return current;
}

/** Construct the SDK's PeopleClient using the CLI's stored credentials. */
async function buildPeopleClient(appId: string) {
  const config = await getMergedConfig();
  const client = createClient({
    appId,
    apiUrl: config.endpoint ?? 'https://api.butterbase.ai',
    anonKey: config.apiKey ?? '',
  });
  return client.people;
}

/** Format a PeopleMeta footer line (credits + USD charged + cache status). */
function metaFooter(meta: PeopleMeta): string {
  const parts: string[] = [
    `${meta.creditsConsumed} credit${meta.creditsConsumed === 1 ? '' : 's'}`,
    `$${meta.usdCharged.toFixed(5)}`,
  ];
  if (meta.cached !== undefined) {
    parts.push(meta.cached ? chalk.green('cached') : 'live fetch');
  }
  return chalk.gray(parts.join(' · '));
}

/** Truncate a string to maxLen, appending '…' if truncated. */
function trunc(s: string | null | undefined, maxLen: number): string {
  const str = s ?? '—';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

/** Right-pad a string to width with spaces. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ─── search-person ────────────────────────────────────────────────────────────

export async function peopleSearchPersonCommand(
  query: string,
  options: { app?: string; filters?: string; limit?: number; json?: boolean },
): Promise<void> {
  const appId = await requireAppId(options.app);
  const spinner = ora('Searching for people…').start();

  try {
    const people = await buildPeopleClient(appId);

    let req: Record<string, unknown> = { query, pageSize: options.limit ?? 10 };

    if (options.filters) {
      try {
        const parsed = JSON.parse(options.filters);
        req = { ...parsed, pageSize: options.limit ?? 10 };
        if (query) req.query = query;
      } catch {
        spinner.fail('--filters is not valid JSON');
        process.exit(1);
      }
    }

    const { data, meta } = await people.searchPerson(req as any);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({ data, meta }, null, 2));
      return;
    }

    const results = data.results ?? [];
    if (results.length === 0) {
      console.log(chalk.gray('No results found.'));
      return;
    }

    console.log('');
    console.log(
      chalk.bold(pad('Name', 24)) +
      chalk.bold(pad('Headline', 32)) +
      chalk.bold(pad('Location', 22)) +
      chalk.bold('LinkedIn URL'),
    );
    console.log(chalk.gray('─'.repeat(110)));

    for (const r of results) {
      const profile = r.profile;
      const name = trunc(profile?.fullName, 23);
      const headline = trunc(profile?.headline, 31);
      const location = trunc(
        [profile?.city, profile?.country].filter(Boolean).join(', '),
        21,
      );
      const url = r.linkedinProfileUrl ?? '—';
      console.log(pad(name, 24) + pad(headline, 32) + pad(location, 22) + chalk.cyan(url));
    }

    console.log('');
    console.log(
      chalk.gray(`Returned ${results.length} result${results.length === 1 ? '' : 's'}`) +
      chalk.gray(' · ') +
      metaFooter(meta),
    );
  } catch (e) {
    spinner.fail('Search failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── search-company ───────────────────────────────────────────────────────────

export async function peopleSearchCompanyCommand(
  query: string,
  options: { app?: string; filters?: string; limit?: number; json?: boolean },
): Promise<void> {
  const appId = await requireAppId(options.app);
  const spinner = ora('Searching for companies…').start();

  try {
    const people = await buildPeopleClient(appId);

    let req: Record<string, unknown> = { query, pageSize: options.limit ?? 10 };

    if (options.filters) {
      try {
        const parsed = JSON.parse(options.filters);
        req = { ...parsed, pageSize: options.limit ?? 10 };
        if (query) req.query = query;
      } catch {
        spinner.fail('--filters is not valid JSON');
        process.exit(1);
      }
    }

    const { data, meta } = await people.searchCompany(req as any);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({ data, meta }, null, 2));
      return;
    }

    const results = data.results ?? [];
    if (results.length === 0) {
      console.log(chalk.gray('No results found.'));
      return;
    }

    console.log('');
    console.log(
      chalk.bold(pad('Name', 28)) +
      chalk.bold(pad('LinkedIn URL', 48)) +
      chalk.bold(pad('Industry', 28)) +
      chalk.bold('Employees'),
    );
    console.log(chalk.gray('─'.repeat(116)));

    for (const c of results) {
      const name = trunc(c.name, 27);
      const url = trunc(c.linkedinUrl, 47);
      const industry = trunc(c.industry, 27);
      const employees = c.employeeCount != null ? String(c.employeeCount) : '—';
      console.log(
        pad(name, 28) +
        pad(chalk.cyan(url), 48) +
        pad(industry, 28) +
        employees,
      );
    }

    console.log('');
    console.log(
      chalk.gray(`Returned ${results.length} result${results.length === 1 ? '' : 's'}`) +
      chalk.gray(' · ') +
      metaFooter(meta),
    );
  } catch (e) {
    spinner.fail('Search failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── profile ──────────────────────────────────────────────────────────────────

export async function peopleProfileCommand(
  linkedinUrl: string,
  options: { app?: string; live?: boolean; json?: boolean },
): Promise<void> {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching profile…').start();

  try {
    const people = await buildPeopleClient(appId);
    const { data, meta } = await people.getProfile({
      linkedinProfileUrl: linkedinUrl,
      liveFetch: options.live ? 'force' : undefined,
    });
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({ data, meta }, null, 2));
      return;
    }

    if (!data) {
      console.log(chalk.gray('Profile not found.'));
      return;
    }

    const p = data as ProfilePayload;

    console.log('');
    console.log(chalk.bold('  ' + (p.fullName ?? '—')));
    if (p.headline) console.log('  ' + chalk.gray(p.headline));
    if (p.city || p.country) {
      console.log('  ' + chalk.gray([p.city, p.country].filter(Boolean).join(', ')));
    }
    console.log('');

    // Experiences (top 3)
    const exps = Array.isArray(p.experiences) ? p.experiences.slice(0, 3) : [];
    if (exps.length > 0) {
      console.log(chalk.bold('  Experience'));
      for (const ex of exps) {
        const e = ex as any;
        const title = e.title ?? e.jobTitle ?? '—';
        const company = e.company ?? e.companyName ?? '';
        const dates = [e.startDate ?? e.starts_at, e.endDate ?? e.ends_at]
          .map((d: any) => (d ? (typeof d === 'object' ? `${d.year ?? '?'}` : String(d)) : null))
          .filter(Boolean)
          .join(' – ') || '';
        console.log(`    ${chalk.cyan(title)}${company ? ` at ${company}` : ''}${dates ? chalk.gray('  ' + dates) : ''}`);
      }
      console.log('');
    }

    // Education
    const edu = Array.isArray(p.education) ? p.education : [];
    if (edu.length > 0) {
      console.log(chalk.bold('  Education'));
      for (const ed of edu) {
        const e = ed as any;
        const school = e.school ?? e.schoolName ?? '—';
        const degree = [e.degree ?? e.degreeName, e.fieldOfStudy].filter(Boolean).join(', ');
        console.log(`    ${chalk.cyan(school)}${degree ? chalk.gray('  ' + degree) : ''}`);
      }
      console.log('');
    }

    console.log('  ' + metaFooter(meta));
    console.log('');
  } catch (e) {
    spinner.fail('Profile fetch failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── email-lookup ─────────────────────────────────────────────────────────────

export async function peopleEmailLookupCommand(
  linkedinUrl: string,
  options: { app?: string; json?: boolean },
): Promise<void> {
  const appId = await requireAppId(options.app);
  const spinner = ora('Queuing email lookup…').start();

  try {
    const people = await buildPeopleClient(appId);
    const { data, meta } = await people.queueEmailLookup({ linkedinProfileUrl: linkedinUrl });
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({ data, meta }, null, 2));
      return;
    }

    console.log('');
    console.log(chalk.green('Email lookup queued.'));
    console.log(`  Lookup ID: ${chalk.cyan(data.lookupId)}`);
    console.log(`  Status:    ${data.status}`);
    console.log('');
    console.log(chalk.gray(`Poll for results with: butterbase people email-status ${data.lookupId}`));
    console.log('  ' + metaFooter(meta));
  } catch (e) {
    spinner.fail('Email lookup failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── email-status ─────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['resolved', 'failed', 'expired']);
const WATCH_POLL_INTERVAL_MS = 5_000;
const WATCH_MAX_POLLS = 60; // 5 minutes

export async function peopleEmailStatusCommand(
  lookupId: string,
  options: { app?: string; json?: boolean; watch?: boolean },
): Promise<void> {
  const appId = await requireAppId(options.app);

  try {
    const people = await buildPeopleClient(appId);

    if (!options.watch) {
      const spinner = ora('Fetching email lookup status…').start();
      const { data, meta } = await people.getEmailLookup(lookupId);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({ data, meta }, null, 2));
        return;
      }

      console.log('');
      console.log(`  Status:           ${chalk.cyan(data.status)}`);
      if (data.email) console.log(`  Email:            ${chalk.green(data.email)}`);
      if (data.creditsConsumed != null) console.log(`  Credits consumed: ${data.creditsConsumed}`);
      console.log('');
      return;
    }

    // Watch mode: poll until terminal status or timeout
    console.log(chalk.gray(`Watching lookup ${lookupId} (every ${WATCH_POLL_INTERVAL_MS / 1000}s, max ${WATCH_MAX_POLLS * WATCH_POLL_INTERVAL_MS / 60_000} min)…`));
    let lastStatus = '';

    for (let i = 0; i < WATCH_MAX_POLLS; i++) {
      const { data } = await people.getEmailLookup(lookupId);

      if (data.status !== lastStatus) {
        lastStatus = data.status;
        const ts = new Date().toLocaleTimeString();
        const statusStr = TERMINAL_STATUSES.has(data.status)
          ? chalk.green(data.status)
          : chalk.yellow(data.status);
        process.stdout.write(`[${ts}] ${statusStr}`);
        if (data.email) process.stdout.write(`  email: ${chalk.green(data.email)}`);
        if (data.creditsConsumed != null) process.stdout.write(`  credits: ${data.creditsConsumed}`);
        process.stdout.write('\n');
      }

      if (TERMINAL_STATUSES.has(data.status)) {
        if (options.json) console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (i < WATCH_MAX_POLLS - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, WATCH_POLL_INTERVAL_MS));
      }
    }

    console.log(chalk.yellow('Watch timed out after 5 minutes. Run the command again to check status.'));
    process.exit(1);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
