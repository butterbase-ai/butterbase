import type { ButterbaseClient } from '../lib/butterbase-client.js';
import { AdminSchemaClient } from './schema-client.js';
import { AdminRlsClient } from './rls-client.js';
import { AdminOAuthClient } from './oauth-client.js';
import { AdminConfigClient } from './config-client.js';
import { AdminFunctionsClient } from './functions-client.js';
import { AdminApiKeysClient } from './api-keys-client.js';
import { AdminAuditLogsClient } from './audit-logs-client.js';
import { AdminFrontendClient } from './frontend-client.js';
import { AdminRealtimeClient } from './realtime-client.js';
import { AdminDomainsClient } from './domains-client.js';
import { AdminDurableObjectsClient } from './durable-objects-client.js';
import { AdminEdgeSsrClient } from './edge-ssr-client.js';
import { AdminMigrationsClient } from './migrations-client.js';
import { AdminPlatformBillingClient } from './platform-billing-client.js';

export class AdminClient {
  readonly schema: AdminSchemaClient;
  readonly rls: AdminRlsClient;
  readonly oauth: AdminOAuthClient;
  readonly config: AdminConfigClient;
  readonly functions: AdminFunctionsClient;
  readonly apiKeys: AdminApiKeysClient;
  readonly auditLogs: AdminAuditLogsClient;
  readonly frontend: AdminFrontendClient;
  readonly realtime: AdminRealtimeClient;
  readonly domains: AdminDomainsClient;
  readonly durableObjects: AdminDurableObjectsClient;
  readonly edgeSsr: AdminEdgeSsrClient;
  readonly migrations: AdminMigrationsClient;
  readonly platformBilling: AdminPlatformBillingClient;

  constructor(client: ButterbaseClient) {
    this.schema = new AdminSchemaClient(client);
    this.rls = new AdminRlsClient(client);
    this.oauth = new AdminOAuthClient(client);
    this.config = new AdminConfigClient(client);
    this.functions = new AdminFunctionsClient(client);
    this.apiKeys = new AdminApiKeysClient(client);
    this.auditLogs = new AdminAuditLogsClient(client);
    this.frontend = new AdminFrontendClient(client);
    this.realtime = new AdminRealtimeClient(client);
    this.domains = new AdminDomainsClient(client);
    this.durableObjects = new AdminDurableObjectsClient(client);
    this.edgeSsr = new AdminEdgeSsrClient(client);
    this.migrations = new AdminMigrationsClient(client);
    this.platformBilling = new AdminPlatformBillingClient(client);
  }
}
