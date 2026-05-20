import chalk from 'chalk';
import { queryAuditLogs } from '../lib/api-client.js';
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

export async function auditQueryCommand(options: {
  app?: string;
  category?: string;
  eventType?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  try {
    const r: any = await queryAuditLogs(appId, {
      category: options.category,
      event_type: options.eventType,
      action: options.action,
      resource_type: options.resourceType,
      resource_id: options.resourceId,
      actor_id: options.actorId,
      from: options.from,
      to: options.to,
      limit: options.limit,
      offset: options.offset,
    });
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const logs = r.logs ?? [];
    if (logs.length === 0) {
      console.log(chalk.gray('No audit log entries match.'));
      return;
    }
    for (const l of logs) {
      const sp = `${l.success === false ? chalk.red('FAIL') : 'ok'}`;
      console.log(`${l.created_at}  ${l.category}/${l.event_type}  actor=${l.actor_id ?? '-'}  ${sp}`);
    }
    if (r.nextOffset != null) console.log(chalk.gray(`(next offset: ${r.nextOffset})`));
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
