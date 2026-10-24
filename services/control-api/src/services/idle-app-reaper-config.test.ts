import { expect, it } from 'vitest';
import { idlePauseConfigFromEnv } from './idle-pause-config.js';

it.each([undefined, '', '0', '-1', '28oops', 'NaN', '1.5', 'Infinity', '7'])('does not enable pausing for idle days %s', (days) => {
  expect(idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: days })).toBeNull();
});
it('uses the approved defaults only when explicitly enabled', () => {
  expect(idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '28' })).toEqual({
    days: 28, warnDays: 7, graceDays: 5, minVisitors: 3, dryRun: false,
    plans: ['playground'], maxPerTick: 25, maxFraction: 0.2,
  });
});
it('accepts adjustable thresholds and dry run', () => {
  expect(idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '14', BUTTERBASE_IDLE_PAUSE_WARN_DAYS: '3',
    BUTTERBASE_IDLE_PAUSE_GRACE_DAYS: '2', BUTTERBASE_IDLE_PAUSE_MIN_VISITORS: '5',
    BUTTERBASE_IDLE_PAUSE_MAX_PER_TICK: '10', BUTTERBASE_IDLE_PAUSE_MAX_FRACTION: '0.1',
    BUTTERBASE_IDLE_PAUSE_PLANS: 'playground, test_free', BUTTERBASE_IDLE_PAUSE_DRY_RUN: 'true' })).toEqual({
      days: 14, warnDays: 3, graceDays: 2, minVisitors: 5, maxPerTick: 10, maxFraction: 0.1,
      plans: ['playground', 'test_free'], dryRun: true,
    });
});
it.each([
  ['BUTTERBASE_IDLE_PAUSE_GRACE_DAYS', '-5'], ['BUTTERBASE_IDLE_PAUSE_WARN_DAYS', '28'],
  ['BUTTERBASE_IDLE_PAUSE_MIN_VISITORS', '0'], ['BUTTERBASE_IDLE_PAUSE_MAX_FRACTION', '1.1'],
  ['BUTTERBASE_IDLE_PAUSE_MAX_PER_TICK', 'bad'], ['BUTTERBASE_IDLE_PAUSE_DRY_RUN', 'tru'],
])('fails closed on malformed %s', (key, value) => {
  expect(idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '28', [key]: value })).toBeNull();
});
