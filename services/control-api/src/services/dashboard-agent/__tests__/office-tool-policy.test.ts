/**
 * Task 8 — the Office consequential-tool floor.
 *
 * `classifyOfficeTool` answers a narrower question than `operatorPolicyFor`:
 * what may a CUSTOMER Office do autonomously? The operator table is the general
 * unattended-agent contract, and `yolo_mode` may lift its 'approval' tier for
 * a self-hosted org that opted in. A customer Office never inherits that
 * shortcut for consequential work — deploying, changing live app
 * data/schema/config, deleting or merging records, or contacting anyone — so
 * the loop takes the STRICTER of the two answers.
 *
 * The failures these tests exist to prevent:
 *   - a yolo-enabled Office org shipping a deployment with no human in the loop;
 *   - an integration call reaching a customer because `manage_integrations`
 *     happens to be 'allow' in the operator table;
 *   - an unclassified tool slipping through because nobody wrote a rule for it;
 *   - the classifier drifting from the operator table's self-approval denials.
 */
import { describe, it, expect } from 'vitest';
import { classifyOfficeTool } from '../office-tool-policy.js';
import {
  OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
  OPERATOR_DENIED_SUBSTRATE_ACTIONS,
  resolveOfficeVerdict,
} from '../operator-policy.js';

describe('consequential work requires approval even when the operator tier would allow it', () => {
  it.each([
    // App deployments — the plan's first named category.
    ['deploy_frontend', { app_id: 'app_1' }],
    ['deploy_function_from_workspace', { app_id: 'app_1', function_name: 'send-receipt' }],
    ['deploy_function', { app_id: 'app_1', name: 'send-receipt' }],
    ['manage_edge_ssr', { action: 'start', site_id: 's_1' }],

    // Live data, schema and configuration changes.
    ['manage_schema', { action: 'apply', app_id: 'app_1', schema: { tables: {} } }],
    ['manage_rls', { action: 'disable', app_id: 'app_1', table_name: 'tickets' }],
    ['manage_migrations', { action: 'apply', app_id: 'app_1', name: 'm1' }],
    ['insert_row', { app_id: 'app_1', table: 'tickets', data: { status: 'done' } }],
    ['seed_database', { app_id: 'app_1', table: 'tickets', rows: [] }],
    ['invoke_function', { app_id: 'app_1', function_name: 'send-reminder' }],
    ['manage_function', { action: 'update_env', app_id: 'app_1', function_name: 'f', env: {} }],
    ['manage_auth_config', { action: 'configure_auth_hook', app_id: 'app_1', post_auth_function: 'f' }],
    ['manage_auth_users', { action: 'delete', app_id: 'app_1', user_id: 'u_1' }],
    ['manage_oauth', { action: 'configure', app_id: 'app_1', provider: 'google' }],
    ['manage_api_keys', { action: 'revoke', key_id: 'k_1' }],
    ['manage_storage', { action: 'delete', app_id: 'app_1', object_id: 'o_1' }],
    ['manage_kv', { action: 'set', app_id: 'app_1', key: 'k', value: 1 }],
    ['manage_kv', { action: 'flush', app_id: 'app_1', confirm: true }],
    ['manage_realtime', { action: 'configure', app_id: 'app_1', tables: ['messages'] }],
    ['manage_durable_objects', { action: 'deploy', app_id: 'app_1', name: 'room', code: '...' }],
    ['manage_ai', { action: 'update_config', app_id: 'app_1', config: {} }],
    ['manage_ai', { action: 'start_meeting', app_id: 'app_1', meeting_url: 'https://meet/x' }],
    ['manage_rag_content', { action: 'delete_collection', app_id: 'app_1', name: 'kb' }],
    ['manage_agents', { action: 'create', app_id: 'app_1', name: 'agent', graph_spec: {} }],
    ['manage_app', { action: 'delete', app_id: 'app_1' }],
    ['manage_app', { action: 'update_env', app_id: 'app_1', env: {} }],
    ['init_app', { name: 'new-app' }],
    ['manage_repo', { action: 'wipe', app_id: 'app_1' }],
    ['manage_billing', { action: 'topup', app_id: 'app_1', amount: 5 }],
  ])('%s %j -> approval', (name, args) => {
    expect(classifyOfficeTool(name, args)).toBe('approval');
  });

  it.each([
    // Deleting / merging records, through the substrate capability they name.
    { action: 'propose', capability: 'delete_entity' },
    { action: 'propose', capability: 'merge_entities' },
    { action: 'propose', capability: 'bulk_revert_actions' },
    // Contacting a customer.
    { action: 'propose', capability: 'send_email_draft' },
    { action: 'propose', capability: 'place_call' },
    // Oversight-weakening automation, same set the operator table gates.
    { action: 'create_rule', rule: {} },
    { action: 'delete_rule', rule_id: 'r_1' },
    { action: 'disable_rule', rule_id: 'r_1' },
    { action: 'enable_rule', rule_id: 'r_1' },
    { action: 'cancel_outbox', outbox_id: 'o_1' },
  ])('manage_substrate %j -> approval', (args) => {
    expect(classifyOfficeTool('manage_substrate', args)).toBe('approval');
  });

  it('integration EXECUTION requires approval, including unknown actions', () => {
    expect(classifyOfficeTool('manage_integrations', { action: 'execute_action', tool_name: 'GMAIL_SEND_EMAIL' }))
      .toBe('approval');
    // An action this classifier has never heard of is not a read.
    expect(classifyOfficeTool('manage_integrations', { action: 'some_future_action' }))
      .toBe('approval');
    // Nor is an unreadable argument object.
    expect(classifyOfficeTool('manage_integrations', 'not-json')).toBe('approval');
  });

  it('an unclassified tool is approval, never allow', () => {
    expect(classifyOfficeTool('invented_tool', {})).toBe('approval');
    expect(classifyOfficeTool('manage_preview', { app_id: 'app_1' })).toBe('approval');
  });
});

describe('reads, preparation and builds stay allowed', () => {
  it.each([
    ['butterbase_docs', { query: 'storage' }],
    ['list_regions', {}],
    ['select_rows', { app_id: 'app_1', table: 'tickets', limit: 10 }],
    ['query_audit_logs', { app_id: 'app_1' }],
    ['rag_query', { app_id: 'app_1', collection: 'kb', query: 'refund' }],
    ['manage_people', { action: 'search_person', current_role_title: 'CTO' }],
    // Preparation: the workspace and the sandbox, not the live app.
    ['write_file', { app_id: 'app_1', path: 'src/App.tsx', content: '...' }],
    ['delete_file', { app_id: 'app_1', path: 'src/old.tsx' }],
    ['read_file', { app_id: 'app_1', path: 'src/App.tsx' }],
    ['list_files', { app_id: 'app_1' }],
    ['run_sandbox_code', { code: 'print(1)' }],
    ['build_app', { app_id: 'app_1' }],
    ['update_operator_scratchpad', { content: 'notes' }],
    ['list_pending_decisions', {}],
    ['manage_repo', { action: 'push', app_id: 'app_1', files: [] }],
    ['manage_repo', { action: 'pull_latest', app_id: 'app_1' }],
    ['submit_suggestion', { category: 'improvement', description: 'x' }],
    ['list_partner_apis', {}],
  ])('%s %j -> allow', (name, args) => {
    expect(classifyOfficeTool(name, args)).toBe('allow');
  });

  it.each([
    ['manage_app', { action: 'list' }],
    ['manage_app', { action: 'get_config', app_id: 'app_1' }],
    ['manage_schema', { action: 'get', app_id: 'app_1' }],
    ['manage_schema', { action: 'dry_run', app_id: 'app_1', schema: { tables: {} } }],
    ['manage_migrations', { action: 'list_migrations', app_id: 'app_1' }],
    ['manage_rls', { action: 'list', app_id: 'app_1' }],
    ['manage_auth_users', { action: 'list', app_id: 'app_1' }],
    ['manage_oauth', { action: 'get', app_id: 'app_1' }],
    ['manage_api_keys', { action: 'list' }],
    ['manage_storage', { action: 'download_url', app_id: 'app_1', object_id: 'o_1' }],
    ['manage_storage', { action: 'list', app_id: 'app_1' }],
    ['manage_kv', { action: 'get', app_id: 'app_1', key: 'k' }],
    ['manage_kv', { action: 'mget', app_id: 'app_1', keys: ['a'] }],
    ['manage_realtime', { action: 'get', app_id: 'app_1' }],
    ['manage_durable_objects', { action: 'list', app_id: 'app_1' }],
    ['manage_edge_ssr', { action: 'list', app_id: 'app_1' }],
    ['manage_ai', { action: 'list_models', app_id: 'app_1' }],
    ['manage_ai', { action: 'chat', app_id: 'app_1', messages: [] }],
    ['manage_rag_content', { action: 'list_documents', app_id: 'app_1', collection: 'kb' }],
    ['manage_agents', { action: 'list', app_id: 'app_1' }],
    ['manage_billing', { action: 'status', app_id: 'app_1' }],
    ['manage_billing', { action: 'plans' }],
    ['manage_integrations', { action: 'list_tools', app_id: 'app_1' }],
    ['manage_integrations', { action: 'list_connected', app_id: 'app_1' }],
    ['manage_integrations', { action: 'list_available', app_id: 'app_1' }],
  ])('%s read action %j -> allow', (name, args) => {
    expect(classifyOfficeTool(name, args)).toBe('allow');
  });

  it.each([
    ['list_actions', { action: 'list_actions' }],
    ['get_entity', { action: 'get_entity', entity_id: 'e_1' }],
    ['search_memory', { action: 'search_memory', q: 'refund' }],
    ['propose', { action: 'propose', capability: 'record_decision' }],
    ['retry_outbox', { action: 'retry_outbox', outbox_id: 'o_1' }],
  ])('manage_substrate read/memory action %s -> allow', (_label, args) => {
    expect(classifyOfficeTool('manage_substrate', args)).toBe('allow');
  });
});

describe('the agent may never weaken its own controls', () => {
  it.each([...OPERATOR_DENIED_SUBSTRATE_ACTIONS])(
    'manage_substrate %s is DENIED, not gated for approval',
    (action) => {
      expect(classifyOfficeTool('manage_substrate', { action })).toBe('deny');
    },
  );

  it('a control-weakening action stays denied even with extra arguments', () => {
    expect(classifyOfficeTool('manage_substrate', { action: 'set_yolo', yolo_mode: true })).toBe('deny');
  });

  it('unreadable manage_substrate args fail closed to deny', () => {
    expect(classifyOfficeTool('manage_substrate', '{bad json')).toBe('deny');
    expect(classifyOfficeTool('manage_substrate', '["not","an","object"]')).toBe('deny');
  });

  it('the approval set mirrors the operator table', () => {
    for (const action of OPERATOR_APPROVAL_SUBSTRATE_ACTIONS) {
      expect(classifyOfficeTool('manage_substrate', { action })).toBe('approval');
    }
  });
});

describe('resolveOfficeVerdict precedence', () => {
  it('never lets the Office floor lift an operator denial', () => {
    // A foreign org_id (operator deny) plus a consequential Office action
    // (Office approval) must stay denied. Turning it into an approval would put
    // a cross-organization proposal in front of the owner even though the
    // executor refuses it.
    expect(resolveOfficeVerdict('deny', 'approval')).toBe('deny');
    expect(resolveOfficeVerdict('deny', 'allow')).toBe('deny');
    expect(resolveOfficeVerdict('deny', 'deny')).toBe('deny');
  });

  it('keeps the Office approval binding over an operator allow', () => {
    expect(resolveOfficeVerdict('allow', 'approval')).toBe('approval');
    expect(resolveOfficeVerdict('approval', 'approval')).toBe('approval');
  });

  it('lets an Office allow clear the operator approval tier for preparation', () => {
    expect(resolveOfficeVerdict('approval', 'allow')).toBe('allow');
    expect(resolveOfficeVerdict(null, 'allow')).toBe('allow');
  });

  it('keeps an Office denial absolute', () => {
    expect(resolveOfficeVerdict('allow', 'deny')).toBe('deny');
    expect(resolveOfficeVerdict('approval', 'deny')).toBe('deny');
    expect(resolveOfficeVerdict(null, 'deny')).toBe('deny');
  });
});

describe('skill tools and the org-scoped read action', () => {
  it('allows the two Office skill tools', () => {
    expect(classifyOfficeTool('skill_creator', { request: 'check the sheet every morning' })).toBe('allow');
    expect(classifyOfficeTool('run_skill_script', { entrypoint: 'scripts/check.py' })).toBe('allow');
  });

  it('allows only the read action on manage_integrations', () => {
    expect(classifyOfficeTool('manage_integrations', {
      action: 'execute_read', tool_slug: 'GOOGLESHEETS_GET_VALUES',
    })).toBe('allow');
    expect(classifyOfficeTool('manage_integrations', {
      action: 'execute_action', tool_slug: 'GOOGLESHEETS_UPDATE_VALUES',
    })).toBe('approval');
    expect(classifyOfficeTool('manage_integrations', { action: 'send_email' })).toBe('approval');
    expect(classifyOfficeTool('manage_integrations', {})).toBe('approval');
  });
});
