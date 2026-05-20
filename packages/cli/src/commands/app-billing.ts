import chalk from 'chalk';
import ora from 'ora';
import {
  createPlan, updatePlan, listPlans,
  createProduct, updateProduct, listProducts,
  subscribePlan, getSubscription, cancelSubscription,
  purchase, listOrders, getOrder,
} from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

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

// ─── Plans ───────────────────────────────────────────────────────────────────

export async function plansListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r: any = await listPlans(appId);
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const list = r.plans ?? r;
    for (const p of list) console.log(`${p.id}  ${p.name}  ${p.price_cents}¢/${p.interval}`);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function plansCreateCommand(options: {
  app?: string; name: string; priceCents: number; interval: 'month' | 'year'; description?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Creating plan '${options.name}'...`).start();
  try {
    const r: any = await createPlan(appId, {
      name: options.name, price_cents: options.priceCents, interval: options.interval,
      ...(options.description ? { description: options.description } : {}),
    });
    spinner.succeed(`Created plan ${r.id ?? options.name}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Create plan failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function plansUpdateCommand(planId: string, options: {
  app?: string; name?: string; priceCents?: number; description?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.name) body.name = options.name;
  if (options.priceCents !== undefined) body.price_cents = options.priceCents;
  if (options.description) body.description = options.description;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass at least one of --name, --price-cents, --description'));
    process.exit(1);
  }
  const spinner = ora(`Updating plan ${planId}...`).start();
  try {
    const r = await updatePlan(appId, planId, body);
    spinner.succeed(`Updated plan ${planId}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Update plan failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── Products ────────────────────────────────────────────────────────────────

export async function productsListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r: any = await listProducts(appId);
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const list = r.products ?? r;
    for (const p of list) console.log(`${p.id}  ${p.name}  ${p.price_cents}¢`);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function productsCreateCommand(options: {
  app?: string; name: string; priceCents: number; description?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Creating product '${options.name}'...`).start();
  try {
    const r: any = await createProduct(appId, {
      name: options.name, price_cents: options.priceCents,
      ...(options.description ? { description: options.description } : {}),
    });
    spinner.succeed(`Created product ${r.id ?? options.name}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Create product failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function productsUpdateCommand(productId: string, options: {
  app?: string; name?: string; priceCents?: number; description?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.name) body.name = options.name;
  if (options.priceCents !== undefined) body.price_cents = options.priceCents;
  if (options.description) body.description = options.description;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update'));
    process.exit(1);
  }
  const spinner = ora(`Updating product ${productId}...`).start();
  try {
    const r = await updateProduct(appId, productId, body);
    spinner.succeed(`Updated product ${productId}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Update product failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

export async function subscribeCommand(planId: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Subscribing to ${planId}...`).start();
  try {
    const r = await subscribePlan(appId, { plan_id: planId });
    spinner.succeed(`Subscribed to ${planId}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Subscribe failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function subscriptionCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await getSubscription(appId);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function cancelCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Cancelling subscription...').start();
  try {
    const r = await cancelSubscription(appId);
    spinner.succeed('Subscription cancelled');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Cancel failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function purchaseCommand(productId: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Purchasing ${productId}...`).start();
  try {
    const r = await purchase(appId, { product_id: productId });
    spinner.succeed('Purchased');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Purchase failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function ordersListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r: any = await listOrders(appId);
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const list = r.orders ?? r;
    for (const o of list) console.log(`${o.id}  ${o.status}  ${o.amount_cents}¢  ${o.created_at}`);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function ordersGetCommand(orderId: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await getOrder(appId, orderId);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
