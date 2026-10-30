import { describe, expect, it } from 'vitest';
import {
  OFFICE_ACTIONS, officeActionSchema, decisionRefSchema, officeStatusResultSchema,
  confirmationReceiptSchema, officeTurnSchema, officePublicEventSchema, officeErrorSchema,
} from './office.js';

const org_id = 'a0000000-0000-4000-8000-000000000001';
const request = (action: string, fields: Record<string, unknown> = {}) => ({ action, org_id, ...fields });

describe('Office wire requests', () => {
  it('accepts exactly the agreed action vocabulary', () => {
    expect([...OFFICE_ACTIONS].sort()).toEqual([
      'status', 'enable', 'pause', 'resume', 'list_decisions', 'get_decision',
      'get_decision_context', 'approve', 'deny', 'create_conversation', 'list_conversations',
      'get_conversation', 'ask', 'list_memory', 'search_memory', 'get_source_artifact',
      'record_decision', 'record_commitment', 'record_learning', 'list_principles',
      'get_principle', 'record_principle',
    ].sort());
    expect(new Set(OFFICE_ACTIONS).size).toBe(22);
    expect(officeActionSchema.safeParse(request('execute_anything')).success).toBe(false);
  });

  it.each([undefined, '', 'personal', 'not-a-uuid'])('requires explicit UUID org scope (%s)', (value) => {
    expect(officeActionSchema.safeParse({ action: 'status', org_id: value }).success).toBe(false);
  });

  it.each([
    request('status', { message: 'ignored?' }),
    request('pause', { dangerously_skip_approval: true, idempotency_key: 'pause-1' }),
    request('ask', { message: 'Hello', idempotency_key: 'ask-1', capability: 'send_email' }),
    request('get_conversation', { conversation_id: 'conv-1', after_sequence: 1 }),
    request('status', { confirmation_id: 'receipt-1', limit: 5 }),
    request('search_memory', { query: 'hiring', cursor: 'unsupported-native-search-cursor' }),
  ])('rejects unknown or inappropriate fields: %j', (input) => {
    expect(officeActionSchema.safeParse(input).success).toBe(false);
  });

  it('requires decision IDs and uses an explicit source with Office as default', () => {
    expect(officeActionSchema.safeParse(request('get_decision')).success).toBe(false);
    expect(officeActionSchema.parse(request('get_decision', { decision_id: 'apr_1' })))
      .toMatchObject({ decision_source: 'office', decision_id: 'apr_1' });
    expect(decisionRefSchema.parse({ source: 'substrate', id: 'act_1' })).toEqual({ source: 'substrate', id: 'act_1' });
    expect(decisionRefSchema.safeParse({ source: 'email', id: 'act_1' }).success).toBe(false);
    expect(officeActionSchema.safeParse(request('deny', { decision_id: 'apr_1', reason: '  ' })).success).toBe(false);
  });

  it('requires idempotency on protected operations and bounds Ask observation', () => {
    expect(officeActionSchema.safeParse(request('enable')).success).toBe(false);
    expect(officeActionSchema.parse(request('ask', { message: 'Hello', idempotency_key: 'ask-1' })))
      .toMatchObject({ wait_ms: 15_000 });
    for (const wait_ms of [-1, 25_001, 1.5]) {
      expect(officeActionSchema.safeParse(request('ask', { message: 'Hi', idempotency_key: 'k', wait_ms })).success).toBe(false);
    }
  });

  it('accepts opaque page cursors through the backend limit independently of record ID length', () => {
    for (const action of ['list_memory', 'list_principles', 'list_decisions', 'list_conversations']) {
      expect(officeActionSchema.safeParse(request(action, { cursor: 'a'.repeat(700) })).success).toBe(true);
      expect(officeActionSchema.safeParse(request(action, { cursor: 'a'.repeat(2049) })).success).toBe(false);
    }
  });

  it('preserves nested memory JSON and rejects scope/approval injection', () => {
    const payload = { description: 'Deliver order', status: 'confirmed', attrs: { order: { line_items: [1, 2] } } };
    expect(officeActionSchema.parse(request('record_commitment', { payload, idempotency_key: 'com-1' })))
      .toMatchObject({ payload });
    expect(officeActionSchema.safeParse(request('record_commitment', { payload: { ...payload, org_id }, idempotency_key: 'c' })).success).toBe(false);
    expect(officeActionSchema.safeParse(request('record_commitment', { payload: JSON.stringify(payload), idempotency_key: 'c' })).success).toBe(false);
  });

  it.each([
    ['record_decision', { title: 'Missing kind' }],
    ['record_commitment', { description: 'Missing status' }],
    ['record_learning', { title: 'Missing description' }],
    ['record_principle', { title: 'Missing policy' }],
  ])('enforces native memory requirements for %s', (action, payload) => {
    expect(officeActionSchema.safeParse(request(action, { payload, idempotency_key: 'memory-1' })).success).toBe(false);
  });

  it('accepts principle objects with native ambient default', () => {
    expect(officeActionSchema.parse(request('record_principle', {
      idempotency_key: 'principle-1',
      payload: { title: 'No email', applies_to: { capability: 'send_email' }, constraint_spec: { type: 'forbid' } },
    }))).toMatchObject({ payload: { salience: 'ambient', constraint_spec: { type: 'forbid' } } });
  });
});

describe('Office wire results', () => {
  const receipt = {
    state: 'awaiting_confirmation', confirmation_id: 'receipt-1',
    confirmation_url: 'https://office.butterbase.ai/office/confirm/receipt-1',
    expires_at: '2026-10-29T20:00:00.000Z',
  };
  it('distinguishes lifecycle status from a pending confirmation', () => {
    expect(officeStatusResultSchema.parse(receipt)).toEqual(receipt);
    expect(officeStatusResultSchema.parse({
      organization_id: org_id, activation_state: 'enabled', can_enable: false,
      can_approve: true, work_allowed: false, blocked_reason: 'paused_by_owner', paused: true, last_turn: null,
    })).toMatchObject({ paused: true });
    expect(confirmationReceiptSchema.safeParse({ ...receipt, state: 'succeeded' }).success).toBe(false);
    expect(confirmationReceiptSchema.parse({ confirmation_id: 'receipt-1', state: 'succeeded', outcome: { paused: true } }))
      .toMatchObject({ state: 'succeeded', outcome: { paused: true } });
  });

  it('requires decision references on suspended turns and errors on failures', () => {
    const turn = { turn_id: 'turn-1', conversation_id: 'conv-1', state: 'awaiting_approval', output: '' };
    expect(officeTurnSchema.safeParse(turn).success).toBe(false);
    expect(officeTurnSchema.parse({ ...turn, decision: { source: 'office', id: 'apr_1' } })).toMatchObject({ state: 'awaiting_approval' });
    expect(officeTurnSchema.safeParse({ ...turn, state: 'failed' }).success).toBe(false);
  });

  it('accepts typed conflicts and rejects private/raw event payloads', () => {
    expect(officeErrorSchema.parse({ code: 'idempotency_conflict', message: 'Use a new request key.' })).toMatchObject({ code: 'idempotency_conflict' });
    expect(officePublicEventSchema.parse({ type: 'text_delta', sequence: 1, text: 'Hi' })).toEqual({ type: 'text_delta', sequence: 1, text: 'Hi' });
    expect(officePublicEventSchema.safeParse({ type: 'text_delta', sequence: 1, text: 'Hi', tool_args: { token: 'secret' } }).success).toBe(false);
    expect(officePublicEventSchema.safeParse({ type: 'text_delta', sequence: 0, text: 'Hi' }).success).toBe(false);
  });
  it('carries expired replay history pointers without implying live replay succeeded', () => {
    expect(officeErrorSchema.safeParse({ code: 'events_expired', message: 'Replay expired',
      history: { turn_id: 'turn-1', conversation_id: 'conv-1', state: 'completed' } }).success).toBe(true);
  });
});
