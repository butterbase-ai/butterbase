import type { CloneJobStatus } from './clone-jobs.js';

/**
 * The single declaration of what a replay consists of, and which parts of it
 * travel in a promote.
 *
 * When you add a new per-app primitive, add a row here. That is the whole
 * change — executePromote iterates this list. A row with `promotable: false`
 * MUST carry a `reason`, so "we forgot" and "we decided not to" are
 * distinguishable a year from now.
 */
export interface ReplayStep {
  name: string;
  status: CloneJobStatus;
  promotable: boolean;
  reason?: string;
}

export const REPLAY_STEPS: readonly ReplayStep[] = [
  {
    name: 'schema',
    status: 'replaying_schema',
    promotable: true,
  },
  {
    name: 'rls',
    status: 'replaying_rls',
    promotable: true,
  },
  {
    name: 'durable_objects',
    status: 'replaying_durable_objects',
    promotable: true,
  },
  {
    name: 'functions',
    status: 'replaying_functions',
    promotable: true,
  },
  {
    name: 'config',
    status: 'replaying_config',
    promotable: true,
  },
  {
    name: 'repo',
    status: 'copying_repo',
    promotable: true,
  },
  {
    name: 'frontend',
    status: 'copying_repo',
    promotable: true,
  },
  {
    name: 'seed_data',
    status: 'seeding_data',
    promotable: false,
    reason:
      'Promote must never overwrite production rows. Data flows prod → staging '
      + 'only, via staging reset.',
  },
  {
    name: 'integrations',
    status: 'replaying_config',
    promotable: false,
    reason:
      'Staging integrations are deliberately disabled by isolateStagingApp, so '
      + 'promoting them would disable production integrations.',
  },
  {
    name: 'substrate_link',
    status: 'replaying_config',
    promotable: false,
    reason:
      'The substrate link is identity-bearing and is established per app at '
      + 'provision time; re-pointing production at staging linkage is never correct.',
  },
] as const;

export function promotableSteps(): ReplayStep[] {
  return REPLAY_STEPS.filter((s) => s.promotable);
}
