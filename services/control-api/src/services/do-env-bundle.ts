export interface DoEnvBundleInput {
  platformEnv: Record<string, string>;
  appEnvVars: Record<string, string>;
  doEnvVars: Record<string, string>;
  internalFnKey: string | null;
  invokerConfig: { url: string; token: string } | null;
  doBindingNames: string[];
}

export interface DoEnvBundleResult {
  envVars: Record<string, string>;
  collisions: { key: string; reason: 'do_binding' }[];
}

export function buildDoEnvBundle(input: DoEnvBundleInput): DoEnvBundleResult {
  const envVars: Record<string, string> = {
    ...input.appEnvVars,
    ...input.doEnvVars,
    ...input.platformEnv,
  };
  if (input.internalFnKey !== null) {
    envVars.BUTTERBASE_INTERNAL_FN_KEY = input.internalFnKey;
  }
  if (input.invokerConfig !== null) {
    // Not prefixed with BUTTERBASE_ so the bundler's ctx-scrub pass can
    // identify and delete these platform-only keys from user-visible ctx.env.
    // The reserved-prefix guard on manage_durable_objects set_env still
    // prevents users from setting keys of these names.
    envVars.DO_INVOKER_URL = input.invokerConfig.url;
    envVars.DO_INVOKER_TOKEN = input.invokerConfig.token;
  }

  const bindingSet = new Set(input.doBindingNames);
  const collisions: { key: string; reason: 'do_binding' }[] = [];
  for (const k of Object.keys(envVars)) {
    if (bindingSet.has(k)) collisions.push({ key: k, reason: 'do_binding' });
  }
  return { envVars, collisions };
}
