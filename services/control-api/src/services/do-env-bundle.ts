export interface DoEnvBundleInput {
  platformEnv: Record<string, string>;
  appEnvVars: Record<string, string>;
  doEnvVars: Record<string, string>;
  internalFnKey: string | null;
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

  const bindingSet = new Set(input.doBindingNames);
  const collisions: { key: string; reason: 'do_binding' }[] = [];
  for (const k of Object.keys(envVars)) {
    if (bindingSet.has(k)) collisions.push({ key: k, reason: 'do_binding' });
  }
  return { envVars, collisions };
}
