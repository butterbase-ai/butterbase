import { describe, expect, it } from 'vitest';
import { isConfirmedExecution } from '../execution-outcome.js';
const envelope = (value: unknown) => ({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
describe('execution confirmation follows executable contracts', () => {
  it('does not confirm function HTTP errors, timeouts or incomplete results', () => {
    const operation = { toolName: 'invoke_function', toolArgs: {} };
    for (const status of [400, 408, 500, 504]) expect(isConfirmedExecution(operation, envelope({ status, body: 'synthetic' }))).toBe(false);
    expect(isConfirmedExecution(operation, envelope({ body: 'unknown response' }))).toBe(false);
    expect(isConfirmedExecution(operation, envelope({ status: 200, body: 'synthetic' }))).toBe(true);
  });
  it('distinguishes executed native actions from rejected, parked and ambiguous replays', () => {
    const operation = { toolName: 'manage_substrate', toolArgs: { action: 'propose' } };
    expect(isConfirmedExecution(operation, envelope({ status: 'rejected', requires_approval: false, verdict: { result: 'blocked' } }))).toBe(false);
    expect(isConfirmedExecution(operation, envelope({ requires_approval: false, verdict: { result: 'blocked' } }))).toBe(false);
    expect(isConfirmedExecution(operation, envelope({ requires_approval: false, verdict: { result: 'requires_approval' }, replay: true }))).toBe(false);
    expect(isConfirmedExecution(operation, envelope({ status: 'executed', requires_approval: false, verdict: { result: 'requires_approval' }, replay: true }))).toBe(true);
    expect(isConfirmedExecution(operation, envelope({ requires_approval: false, verdict: { result: 'auto_approved' } }))).toBe(true);
    expect(isConfirmedExecution(operation, envelope({ requires_approval: true, action_id: 'act_synthetic' }))).toBe(false);
  });
});
