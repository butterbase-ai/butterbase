/**
 * Region selection for NEW app provisioning (`POST /init`, `POST /clone`).
 *
 * `BUTTERBASE_PROVISION_ALLOWED_REGIONS` lets an operator close a region to new
 * apps without disturbing traffic to apps already homed there. It existed
 * because us-east-1 was approaching Neon's 500-databases-per-branch ceiling;
 * project-per-app removed that ceiling, so the lever now covers the rarer case
 * (a region outage, a bad Neon region) rather than routine capacity pressure.
 *
 * The lever is kept. What is removed is its silence: a redirect used to be
 * invisible to the caller, because the `/init` response carried no region field
 * at all. A customer who asked for us-east-1 got an app in us-west-2 and had no
 * way to find out — which is a data-residency decision being made on their
 * behalf, without telling them. Callers now get `region` on every response, and
 * an explicit `region_redirected_from` when it differs from what they asked for.
 *
 * Redirecting still beats rejecting: when a region really is down, placing the
 * app somewhere that works and saying so is better than failing the request.
 */

export interface RegionResolution {
  /** Where the app will actually be provisioned. */
  region: string;
  /** What the caller asked for (explicitly or by default resolution). */
  requestedRegion: string;
  /** True when `region !== requestedRegion` because the request was redirected. */
  redirected: boolean;
}

/** Parse a comma-separated region list env var into trimmed, non-empty entries. */
export function parseRegionList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Regions currently accepting new apps.
 *
 * Falls back to `BUTTERBASE_REGIONS` when the provisioning-specific var is
 * unset, so `BUTTERBASE_REGIONS` gates both serving and provisioning by
 * default. An empty result means "no restriction configured" — callers treat
 * that as everything-open rather than everything-closed, which is what keeps a
 * missing env var from taking provisioning down entirely.
 */
export function getProvisionAllowedRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseRegionList(
    env.BUTTERBASE_PROVISION_ALLOWED_REGIONS ?? env.BUTTERBASE_REGIONS,
  );
}

/**
 * Resolve the region an app will be provisioned into, redirecting away from a
 * closed region when necessary and reporting whether that happened.
 */
export function resolveProvisionRegion(
  requestedRegion: string,
  provisionAllowed: string[],
): RegionResolution {
  const open = provisionAllowed.length === 0 || provisionAllowed.includes(requestedRegion);
  if (open) {
    return { region: requestedRegion, requestedRegion, redirected: false };
  }
  return {
    region: provisionAllowed[0],
    requestedRegion,
    redirected: true,
  };
}
