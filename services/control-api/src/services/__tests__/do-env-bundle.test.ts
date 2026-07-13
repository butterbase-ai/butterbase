import { describe, it, expect } from 'vitest';
import { buildDoEnvBundle } from '../do-env-bundle.js';

describe('buildDoEnvBundle', () => {
  it('merges with app_env_vars < app_do_env_vars < platform precedence', () => {
    const { envVars } = buildDoEnvBundle({
      platformEnv: { BUTTERBASE_APP_ID: 'app_x' },
      appEnvVars: { STRIPE_SECRET: 'sk_app', SHARED: 'app' },
      doEnvVars:  { SHARED: 'do_override', LOCAL_TO_DO: 'yes' },
      internalFnKey: null,
      doBindingNames: [],
    });
    expect(envVars).toEqual({
      BUTTERBASE_APP_ID: 'app_x',
      STRIPE_SECRET: 'sk_app',
      SHARED: 'do_override',
      LOCAL_TO_DO: 'yes',
    });
  });

  it('injects internalFnKey as BUTTERBASE_INTERNAL_FN_KEY when non-null', () => {
    const { envVars } = buildDoEnvBundle({
      platformEnv: {},
      appEnvVars: {},
      doEnvVars: {},
      internalFnKey: 'kv_abc',
      doBindingNames: [],
    });
    expect(envVars.BUTTERBASE_INTERNAL_FN_KEY).toBe('kv_abc');
  });

  it('omits BUTTERBASE_INTERNAL_FN_KEY when internalFnKey is null', () => {
    const { envVars } = buildDoEnvBundle({
      platformEnv: {},
      appEnvVars: {},
      doEnvVars: {},
      internalFnKey: null,
      doBindingNames: [],
    });
    expect('BUTTERBASE_INTERNAL_FN_KEY' in envVars).toBe(false);
  });

  it('surfaces collisions with DO namespace binding names', () => {
    const { envVars, collisions } = buildDoEnvBundle({
      platformEnv: {},
      appEnvVars: { WIDGET_TICKET_DO: 'oops' },
      doEnvVars: {},
      internalFnKey: null,
      doBindingNames: ['WIDGET_TICKET_DO'],
    });
    expect(collisions).toEqual([{ key: 'WIDGET_TICKET_DO', reason: 'do_binding' }]);
    expect(envVars.WIDGET_TICKET_DO).toBe('oops');
  });

  it('user cannot shadow platform via app_env_vars or do_env_vars', () => {
    const { envVars } = buildDoEnvBundle({
      platformEnv: { BUTTERBASE_APP_ID: 'real' },
      appEnvVars: { BUTTERBASE_APP_ID: 'spoofed_app' },
      doEnvVars:  { BUTTERBASE_APP_ID: 'spoofed_do' },
      internalFnKey: null,
      doBindingNames: [],
    });
    expect(envVars.BUTTERBASE_APP_ID).toBe('real');
  });
});
