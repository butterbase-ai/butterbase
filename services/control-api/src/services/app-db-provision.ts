import { config } from '../config.js';
import * as neonClient from './neon-client.js';
import {
  getDataProjectIdForRegion,
  getNeonRegionIdForRegion,
  getNeonPgVersionForRegion,
} from './neon-projects.js';

export interface ProvisionedDb {
  connectionUri: string;
  poolerConnectionString: string | null;
  neonProjectId: string;
  neonDatabaseName: string;
}

/** Injectable seam. Every member defaults to the real Neon client. */
export interface ProvisionDeps {
  createProjectForApp: typeof neonClient.createProjectForApp;
  ensureRoleExists: typeof neonClient.ensureRoleExists;
  createDatabase: typeof neonClient.createDatabase;
  grantSchemaPrivileges: typeof neonClient.grantSchemaPrivileges;
  withNeonProjectLock: typeof neonClient.withNeonProjectLock;
  getConnectionString: typeof neonClient.getConnectionString;
  waitUntilUriQueryable: typeof neonClient.waitUntilUriQueryable;
  getDataProjectIdForRegion: typeof getDataProjectIdForRegion;
  getNeonRegionIdForRegion: typeof getNeonRegionIdForRegion;
  getNeonPgVersionForRegion: typeof getNeonPgVersionForRegion;
  findProjectByName: typeof neonClient.findProjectByName;
}

function defaultDeps(): ProvisionDeps {
  return {
    createProjectForApp: neonClient.createProjectForApp,
    ensureRoleExists: neonClient.ensureRoleExists,
    createDatabase: neonClient.createDatabase,
    grantSchemaPrivileges: neonClient.grantSchemaPrivileges,
    withNeonProjectLock: neonClient.withNeonProjectLock,
    getConnectionString: neonClient.getConnectionString,
    waitUntilUriQueryable: neonClient.waitUntilUriQueryable,
    getDataProjectIdForRegion,
    getNeonRegionIdForRegion,
    getNeonPgVersionForRegion,
    findProjectByName: neonClient.findProjectByName,
  };
}

/** Pick the pooled connection string for `app_db_connections`.
 *
 *  This function does not itself append the historical `:6543` port. It does
 *  NOT, however, guarantee the port is absent: `getConnectionString` in
 *  neon-client.ts still sets `url.port = '6543'` on its cached-pooler-host
 *  branch, and the `pooled` value is returned here verbatim. So the obsolete
 *  `:6543` convention (design doc §6.2) is not yet fixed — the rewrite just
 *  lives upstream.
 *
 *  Because `getConnectionString` never returns a truthy `poolerHost` without
 *  also returning `pooledConnectionUri`, the host-construct branch below is
 *  effectively unreachable today; it is kept as a defensive fallback should
 *  that upstream contract change. */
function pooledFrom(
  direct: string,
  pooled: string | undefined,
  poolerHost: string | undefined,
): string | null {
  if (pooled) return pooled;
  if (!poolerHost) return null;
  try {
    const url = new URL(direct);
    url.hostname = poolerHost;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Provision the customer Postgres database for one app and return everything
 * the caller needs to write `app_db_connections`.
 *
 * Two shapes, selected by `config.neon.projectPerTenant`:
 *
 *   tenant — one Neon project per app. Single POST creates project, database
 *            and owner role. No role bootstrap, no schema grant, no lock.
 *   legacy — a database inside the region's shared project, serialised behind
 *            the Redis mutex because concurrent creates on one project return
 *            HTTP 423.
 *
 * The caller owns migrations and all database writes.
 */
export async function provisionNeonDbForApp(
  region: string,
  appId: string,
  deps: ProvisionDeps = defaultDeps(),
): Promise<ProvisionedDb> {
  const neonDbName = `db_${appId}`;
  const owner = config.neon.databaseOwner;

  if (config.neon.projectPerTenant) {
    // Idempotency: a retried neon_task must adopt the project a crashed
    // earlier attempt already created, or we leak a billed project per retry.
    // This lookup runs on EVERY tenant provision, not just retries, and an
    // unguarded throw here aborts the provision — that is deliberate. If the
    // lookup fails transiently while a project already exists, degrading to
    // create would produce exactly the duplicate billed project this task
    // exists to prevent, so we fail closed instead. Aborting is safe: the
    // neon_tasks queue retries the whole task, and neonFetch already retries
    // transient failures (423/429/5xx and network errors) before this throws.
    const existing = await deps.findProjectByName(neonClient.projectNameForApp(appId));

    let projectId: string;
    let connectionUri: string;
    // Reused for the pooler lookup below when we adopted rather than created,
    // so we don't call getConnectionString twice for the same project.
    let adoptedConn: Awaited<ReturnType<typeof deps.getConnectionString>> | null = null;

    if (existing) {
      projectId = existing.id;
      adoptedConn = await deps.getConnectionString(projectId, neonDbName, owner);
      connectionUri = adoptedConn.connectionUri;
    } else {
      const created = await deps.createProjectForApp({
        appId,
        neonRegionId: deps.getNeonRegionIdForRegion(region),
        databaseName: neonDbName,
        ownerRole: owner,
        pgVersion: deps.getNeonPgVersionForRegion(region),
      });
      projectId = created.projectId;
      connectionUri = created.connectionUri;
    }

    // POST /projects returns while create_timeline/start_compute are still running.
    await deps.waitUntilUriQueryable(connectionUri, neonDbName);

    // The pooled URI is a nice-to-have; a failure here must not fail provisioning.
    let poolerConnectionString: string | null = null;
    try {
      const conn = adoptedConn ?? (await deps.getConnectionString(projectId, neonDbName, owner));
      poolerConnectionString = pooledFrom(connectionUri, conn.pooledConnectionUri, conn.poolerHost);
    } catch {
      poolerConnectionString = null;
    }

    return {
      connectionUri,
      poolerConnectionString,
      neonProjectId: projectId,
      neonDatabaseName: neonDbName,
    };
  }

  const dataProjectId = deps.getDataProjectIdForRegion(region);

  await deps.withNeonProjectLock(dataProjectId, async () => {
    await deps.ensureRoleExists(dataProjectId, owner);
    await deps.createDatabase(dataProjectId, neonDbName, owner);
  });

  const conn = await deps.getConnectionString(dataProjectId, neonDbName, owner);

  // PG 15+ revokes CREATE on public from non-owners; the shared project's
  // databases are owned by neondb_owner, so the app role needs the grant.
  await deps.grantSchemaPrivileges(dataProjectId, neonDbName, owner);

  return {
    connectionUri: conn.connectionUri,
    poolerConnectionString: pooledFrom(conn.connectionUri, conn.pooledConnectionUri, conn.poolerHost),
    neonProjectId: dataProjectId,
    neonDatabaseName: neonDbName,
  };
}
