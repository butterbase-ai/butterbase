import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import {
  getBilling,
  getUsage,
  createBillingPortal,
  createTopup,
  getSpendingCap,
  raiseSpendingCap,
  listBillingPlans,
} from '../lib/api-client.js';

export async function billingStatusCommand(options: { json?: boolean }) {
  const spinner = ora(text('Fetching billing status...')).start();
  try {
    const result: any = await getBilling();
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Plan:       ${chalk.cyan(result.plan?.name ?? result.plan ?? '—')}`);
    console.log(msg`  Status:     ${result.status ? chalk.green(result.status) : chalk.gray('—')}`);
    if (result.current_period_end) {
      console.log(msg`  Renews:     ${chalk.gray(result.current_period_end)}`);
    }
    if (result.spending_cap !== undefined) {
      console.log(msg`  Spend cap:  ${chalk.yellow(`$${result.spending_cap}`)}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch billing status'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingPortalCommand(options: { json?: boolean }) {
  const spinner = ora(text('Creating billing portal session...')).start();
  try {
    const result: any = await createBillingPortal();
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Portal URL: ${chalk.cyan(result.url)}`);
    console.log(chalk.gray(text('  Open the URL above in your browser to manage your billing.')));
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to create billing portal session'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingTopupCommand(amount: string, options: { json?: boolean }) {
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    console.error(chalk.red(text('amount must be a positive number')));
    process.exit(1);
  }
  const spinner = ora(msg`Adding $${parsed} credit...`).start();
  try {
    const result: any = await createTopup(parsed);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(chalk.green(msg`  ✓ Top-up initiated for $${parsed}`));
    if (result.url) console.log(msg`  URL: ${chalk.cyan(result.url)}`);
    console.log('');
  } catch (err) {
    spinner.fail(text('Top-up failed'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingCapGetCommand(options: { json?: boolean }) {
  const spinner = ora(text('Fetching spending cap...')).start();
  try {
    const result: any = await getSpendingCap();
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Spending cap: ${chalk.yellow(`$${result.spending_cap ?? result.cap ?? '—'}`)}`);
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch spending cap'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingCapRaiseCommand(options: { raiseBy?: string; json?: boolean }) {
  const body: Record<string, unknown> = {};
  if (options.raiseBy !== undefined) {
    const v = parseFloat(options.raiseBy);
    if (isNaN(v) || v <= 0) {
      console.error(chalk.red(text('--raise-by must be a positive number')));
      process.exit(1);
    }
    body.raiseBy = v;
  }
  const spinner = ora(text('Raising spending cap...')).start();
  try {
    const result: any = await raiseSpendingCap(body);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(chalk.green(text(`  ✓ Spending cap updated`)));
    if (result.spending_cap !== undefined) {
      console.log(msg`  New cap: ${chalk.yellow(`$${result.spending_cap}`)}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to raise spending cap'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingPlansCommand(options: { json?: boolean }) {
  const spinner = ora(text('Fetching plans...')).start();
  try {
    const result: any = await listBillingPlans();
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const plans = result.plans ?? result ?? [];
    if (!Array.isArray(plans) || plans.length === 0) {
      console.log(chalk.gray(text('No plans available.')));
      return;
    }
    console.log('');
    for (const p of plans) {
      console.log(`  ${chalk.cyan(p.name ?? p.id)}  ${p.price !== undefined ? chalk.yellow(`$${p.price}`) : ''}  ${chalk.gray(p.description ?? '')}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch plans'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function billingUsageCommand(options: {
  start?: string;
  end?: string;
  meter?: string;
  json?: boolean;
}) {
  const spinner = ora(text('Fetching usage...')).start();
  try {
    const result: any = await getUsage({ startDate: options.start, endDate: options.end, meterType: options.meter });
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const items = result.usage ?? result ?? [];
    if (Array.isArray(items) && items.length === 0) {
      console.log(chalk.gray(text('No usage data for the selected period.')));
      return;
    }
    console.log('');
    if (Array.isArray(items)) {
      for (const u of items) {
        console.log(`  ${chalk.cyan(u.meter ?? u.type ?? u.name)}  ${chalk.gray(u.quantity ?? u.value ?? '')}`);
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch usage'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
