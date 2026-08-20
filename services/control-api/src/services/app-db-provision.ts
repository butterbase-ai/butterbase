import { config } from '../config.js';
import * as neonClient from './neon-client.js';
import { getDataProjectIdForRegion, getNeonRegionIdForRegion } from './neon-projects.js';

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
  };
}

/** Neon returns pooled hosts as `ep-<id>-pooler...` on the default port.
 *  We deliberately do NOT rewrite the port — the historical `:6543` rewrite
 *  is an obsolete Neon convention (design doc §6.2). */
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
    const created = await deps.createProjectForApp({
      appId,
      neonRegionId: deps.getNeonRegionIdForRegion(region),
      databaseName: neonDbName,
      ownerRole: owner,
    });

    // POST /projects returns while create_timeline/start_compute are still running.
    await deps.waitUntilUriQueryable(created.connectionUri, neonDbName);

    // The pooled URI is a nice-to-have; a failure here must not fail provisioning.
    let poolerConnectionString: string | null = null;
    try {
      const conn = await deps.getConnectionString(created.projectId, neonDbName, owner);
      poolerConnectionString = pooledFrom(created.connectionUri, conn.pooledConnectionUri, conn.poolerHost);
    } catch {
      poolerConnectionString = null;
    }

    return {
      connectionUri: created.connectionUri,
      poolerConnectionString,
      neonProjectId: created.projectId,
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
