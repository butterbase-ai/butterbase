import { describe, expect, it } from 'vitest';
import { OFFICE_ACTIONS } from '@butterbase/shared';
import { DOC_TOPICS, getUserDocumentation } from './user-documentation.js';
describe('Office client documentation', () => {
  it('advertises its topic and covers the exact 22 shared actions', () => {
    expect(DOC_TOPICS as readonly string[]).toContain('office');
    const text = getUserDocumentation('office');
    for (const action of OFFICE_ACTIONS) expect(text).toContain(action);
    expect(text).toContain('confirmation_url'); expect(text).toContain('idempotency_key');
  });
  it('includes the optional cloud client contract in complete documentation', () => {
    expect(getUserDocumentation('all')).toContain('manage_office');
  });
});
