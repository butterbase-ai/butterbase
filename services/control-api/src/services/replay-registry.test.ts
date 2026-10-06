import { describe, it, expect } from 'vitest';
import { REPLAY_STEPS, promotableSteps } from './replay-registry.js';

describe('replay registry', () => {
  it('gives every step a unique name', () => {
    const names = REPLAY_STEPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('requires a reason for every non-promotable step', () => {
    for (const step of REPLAY_STEPS.filter((s) => !s.promotable)) {
      expect(step.reason, `step "${step.name}" must explain why it is not promotable`)
        .toBeTruthy();
    }
  });

  it('never promotes seed data — production rows are the point', () => {
    expect(REPLAY_STEPS.find((s) => s.name === 'seed_data')?.promotable).toBe(false);
  });

  it('promotes schema, rls, functions, durable objects, config and frontend', () => {
    const promotable = promotableSteps().map((s) => s.name);
    expect(promotable).toEqual(expect.arrayContaining([
      'schema', 'rls', 'functions', 'durable_objects', 'config', 'frontend',
    ]));
  });

  it('returns a subset of the full registry', () => {
    expect(promotableSteps().length).toBeLessThan(REPLAY_STEPS.length);
  });
});
