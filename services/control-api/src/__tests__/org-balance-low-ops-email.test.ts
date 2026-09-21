import { describe, it, expect } from 'vitest';
import { buildBillingEmailBody } from '../services/auth/email-service.js';

function orgs() {
  return JSON.stringify([
    { id: 'o1', name: 'CutOff Inc', planId: 'enterprise', balanceUsd: -0.004, floorUsd: 0, cutOff: true },
    { id: 'o2', name: 'StillUp Ltd', planId: 'launch', balanceUsd: 0.42, floorUsd: 0, cutOff: false },
  ]);
}

describe('org_balance_low_ops email body', () => {
  it('leads with how many orgs are already cut off', async () => {
    const body = buildBillingEmailBody('org_balance_low_ops', {
      threshold_usd: '1.00',
      org_count: '2',
      cut_off_count: '1',
      orgs_json: orgs(),
    });
    expect(body).toContain('1');
    expect(body.toLowerCase()).toContain('cut off');
  });

  it('lists each org with its plan and balance', () => {
    const body = buildBillingEmailBody('org_balance_low_ops', {
      threshold_usd: '1.00',
      org_count: '2',
      cut_off_count: '1',
      orgs_json: orgs(),
    });
    expect(body).toContain('CutOff Inc');
    expect(body).toContain('enterprise');
    expect(body).toContain('StillUp Ltd');
    expect(body).toContain('launch');
    expect(body).toContain('0.42');
  });

  it('includes the org id so the team can act on it directly', () => {
    const body = buildBillingEmailBody('org_balance_low_ops', {
      threshold_usd: '1.00',
      org_count: '1',
      cut_off_count: '0',
      orgs_json: JSON.stringify([
        { id: 'abc-123', name: 'X', planId: 'launch', balanceUsd: 0.1, floorUsd: 0, cutOff: false },
      ]),
    });
    expect(body).toContain('abc-123');
  });

  it('degrades to the counts when the org payload is unparseable', () => {
    // The digest must still be sendable if the JSON is truncated or malformed
    // — a mangled list is no reason to drop the alert entirely.
    const body = buildBillingEmailBody('org_balance_low_ops', {
      threshold_usd: '1.00',
      org_count: '4',
      cut_off_count: '2',
      orgs_json: '{not json',
    });
    expect(body).toContain('4');
  });
});
