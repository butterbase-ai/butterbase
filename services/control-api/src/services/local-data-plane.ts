/** Explicit local data-plane URL for move provisioning and compensation. */
export function localDataPlaneUrlForRegion(region: string): URL {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BUTTERBASE_LOCAL cannot be used in production');
  }
  const envKey = `LOCAL_DATA_PLANE_URL_${region.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envKey];
  if (!raw) throw new Error(`Missing env var ${envKey} for local move provisioning`);
  try {
    const uri = new URL(raw);
    if (uri.protocol !== 'postgres:' && uri.protocol !== 'postgresql:') throw new Error();
    return uri;
  } catch {
    // URLs may contain credentials; report only the configuration key.
    throw new Error(`${envKey} must be a PostgreSQL connection URL`);
  }
}
