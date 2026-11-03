import { describe, expect, it } from 'vitest';
import { previewOfficeToolValue } from '../office-activity-preview.js';

type Fixture = { tool: string; action?: string; phase: 'input' | 'result'; value: unknown };
const schema = { tables: { orders: { columns: { id: { type: 'uuid', primaryKey: true, nullable: false, unique: true },
  owner_id: { type: 'uuid', references: 'users.id' } },
  indexes: {}, _seed: true, _dropColumns: ['legacy'] } }, _drop: ['old_orders'] };

const fixtures: Fixture[] = [
  { tool: 'manage_schema', action: 'dry_run', phase: 'input', value: { action: 'dry_run', schema } },
  { tool: 'manage_schema', action: 'get', phase: 'result', value: { schema } },
  { tool: 'manage_schema', action: 'dry_run', phase: 'result', value: { applied: 0, dry_run: true, statements: [{ destructive: false }], migration_id: 'mig_1', template_migrations: [{ id: '1', filename: 'initial.sql', applied_at: null }] } },
  { tool: 'manage_migrations', action: 'abort', phase: 'input', value: { action: 'abort', migration_id: 'mig_1' } },
  { tool: 'manage_migrations', action: 'get_active', phase: 'result', value: { migration: { id: 'mig_1', current_step: 'copying', source_region: 'us-east-1', dest_region: 'eu-central-1', source_replica_state: null, step_started_at: null } } },
  { tool: 'manage_migrations', action: 'reverse', phase: 'result', value: { migrationId: 'mig_2', path: '/v1/apps/example/move/mig_2' } },
  { tool: 'manage_migrations', action: 'list_source_replicas', phase: 'result', value: { source_replicas: [{ migration_id: 'mig_1', completed_at: null, estimated_monthly_cost_usd: 0 }] } },
  { tool: 'manage_app', action: 'find_templates', phase: 'input', value: { action: 'find_templates', q: 'invoice', sort: 'popular', limit: 2, offset: 0 } },
  { tool: 'manage_app', action: 'set_substrate_autopropagate', phase: 'input', value: { action: 'set_substrate_autopropagate', users: false } },
  { tool: 'manage_app', action: 'move', phase: 'input', value: { action: 'move', dest_region: 'eu-central-1', migration_id: 'mig_1' } },
  { tool: 'manage_app', action: 'get_clone_job', phase: 'result', value: { job_id: 'job_1', status: 'pending', dest_region: 'eu-central-1', dest_app_id: null, retry_count: 0, completed_at: null } },
  { tool: 'manage_app', action: 'get_clone_job', phase: 'result', value: { pending_env_vars: { submit: ['DISPLAY_NAME'] }, unfilled_env_vars: { submit: ['DISPLAY_NAME'] } } },
  { tool: 'manage_app', action: 'update_env', phase: 'result', value: { updated_keys: ['DISPLAY_NAME'], invalidated: { functions: 2, failed: 0, count: 2, durable_objects_redeployed: false } } },
  { tool: 'manage_app', action: 'publish_template_release', phase: 'result', value: { release_number: 3, label: 'March', snapshot_id: 'snap_1', published_at: '2026-11-03T00:00:00Z', table_count: 2, function_names: ['submit'], required_env: ['DISPLAY_NAME'] } },
  { tool: 'manage_kv', action: 'cas', phase: 'result', value: { swapped: false, wrote: false, applied: true, results: [{ ok: true }] } },
  { tool: 'manage_kv', action: 'stats', phase: 'result', value: { keys_total: 0, bytes_used: 0, ops_per_sec: 0, max_keys: 100, max_storage_bytes: 1000, max_ops_per_sec: 20, max_value_bytes: 512 } },
  { tool: 'manage_rls', action: 'list', phase: 'result', value: { policies: [{ schemaname: 'public', tablename: 'orders', policyname: 'owner_only', permissive: 'PERMISSIVE', roles: ['butterbase_user'], cmd: 'SELECT' }], tables_with_rls: ['orders'] } },
  { tool: 'manage_rls', action: 'delete', phase: 'result', value: { table: 'orders', policies_removed: 2, remaining_policies: 0 } },
  { tool: 'deploy_function', phase: 'input', value: { name: 'submit', envVarsReplace: false, allow_service_key_impersonation: false, triggers: [{ type: 'http', enabled: false }] } },
  { tool: 'deploy_function', phase: 'result', value: { id: 'fn_1', triggers: [{ type: 'http', enabled: true }], cacheInvalidation: { success: true, attempts: 1 } } },
  { tool: 'manage_function', action: 'update_settings', phase: 'result', value: { function: { id: 'fn_1', name: 'submit', allow_service_key_impersonation: false }, updatedKeys: ['DISPLAY_NAME'], cache_invalidation: { success: true, attempts: 1 } } },
  { tool: 'manage_frontend', action: 'configure_custom_domain', phase: 'input', value: { domain_action: 'add', hostname: 'app.example.test', validation_method: 'txt', domain_id: 'domain_1' } },
  { tool: 'manage_frontend', action: 'create_from_source', phase: 'result', value: { deployment_id: 'dep_1', build_id: 'build_1', max_source_bytes: 52428800 } },
  { tool: 'manage_frontend', action: 'list_deployments', phase: 'result', value: { deployments: [{ id: 'dep_1', fileCount: 2, totalSizeBytes: 512, createdAt: '2026-11-03T00:00:00Z', completedAt: null }] } },
  { tool: 'manage_edge_ssr', action: 'list', phase: 'input', value: { limit: 7 } },
  { tool: 'manage_edge_ssr', action: 'list', phase: 'result', value: { deployments: [{ id: 'dep_1', framework: 'nextjs-edge', fileCount: 2, totalSizeBytes: 512, workerScriptSizeBytes: 128, workerScriptModuleCount: 1, startedAt: null, completedAt: null, updatedAt: '2026-11-03T00:00:00Z' }] } },
  { tool: 'manage_durable_objects', action: 'list', phase: 'result', value: { durable_objects: [{ id: 'do_1', class_name: 'Counter', last_deployed_at: null }], do_requests: 0, do_cpu_ms: 0, redeployed: false } },
  { tool: 'manage_ai', action: 'update_config', phase: 'input', value: { config: { defaultModel: 'model_example', defaultDecisionModel: 'decision_example', maxTokensPerRequest: 128, allowedModels: ['model_example'] } } },
  { tool: 'manage_ai', action: 'get_usage', phase: 'input', value: { modality: 'video', startDate: '2026-11-01', endDate: '2026-11-03' } },
  { tool: 'manage_ai', action: 'start_meeting', phase: 'input', value: { meeting_id: 'bot_1', status: 'joining', recording: false, automatic_leave: { waiting_room_timeout_sec: 60 } } },
  { tool: 'manage_ai', action: 'poll_video', phase: 'result', value: { job_id: 'job_1', stage: 'preparing_references', charged_credits_usd: null, settled_at: null, startedAt: null, completedAt: null, durationSeconds: null, botName: 'Assistant' } },
  { tool: 'manage_agents', action: 'update', phase: 'input', value: { name: 'triage', display_name: 'Triage', default_model: 'model_example', status: 'disabled', visibility: 'private', max_runs_per_user_per_hour: 2, max_runs_per_ip_per_hour: 3, max_runs_per_app_per_hour: 4, daily_budget_usd: 1, max_concurrent_runs: 1, safety_acknowledged: false } },
  { tool: 'manage_agents', action: 'get', phase: 'result', value: { agent: { display_name: 'Triage', default_model: null, visibility: 'private', daily_budget_usd: '1.00', max_concurrent_runs: null, safety_acknowledged: false } } },
  { tool: 'manage_integrations', action: 'execute_read', phase: 'input', value: { action: 'execute_read', tool_slug: 'GOOGLESHEETS_GET_VALUES' } },
  { tool: 'manage_integrations', action: 'list_available', phase: 'result', value: { integrations: [{ toolkit: 'calendar', displayName: 'Calendar', curated: true, auth_schemes: ['OAUTH2'] }] } },
  { tool: 'manage_rag_content', action: 'get_collection', phase: 'result', value: { document_counts: { total: 3, pending: 1, processing: 0, ready: 2, failed: 0 } } },
  { tool: 'rag_query', phase: 'result', value: { chunks: [], model: 'model_example', usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } } },
  { tool: 'manage_preview', action: 'set_env_overrides', phase: 'result', value: { staging_app_id: 'app_preview', keys: ['DISPLAY_NAME'], applied_to_staging: false, last_promoted_at: null, last_reset_at: null, paused: false, paused_at: null } },
  { tool: 'promote_preview', action: 'run', phase: 'result', value: { job_id: 'job_1', status: 'pending' } },
  { tool: 'prep_and_submit_hackathon_entry', action: 'submit', phase: 'result', value: { submission: { id: 'entry_1', hackathon_slug: 'example', version: 1, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', app_id: null }, participant_created: false } },
  { tool: 'write_file', phase: 'result', value: { path: 'src/app.ts', sha256: 'a'.repeat(64), size: 12 } },
  { tool: 'read_operator_scratchpad', phase: 'result', value: { format: 'task_notes_v2', updated_at: null } },
  { tool: 'update_operator_scratchpad', phase: 'result', value: { ok: true, characters: 0, updated_at: null } },
  { tool: 'build_app', phase: 'result', value: { ok: false, step: 'build', exit_code: 1, install_skipped: true, dependency_cache_hit: false, baked_modules: true, output_truncated: false, timed_out: false, duration_ms: 12, files_built: 0 } },
  { tool: 'skill_creator', phase: 'input', value: { target_skill_id: 'skill_1', draft_version_id: 'version_1', timezone: 'UTC' } },
  { tool: 'skill_creator', phase: 'result', value: { skill_id: 'skill_1', version_id: 'version_2', version: 2, test_run_id: 'run_1', status: 'testing' } },
  { tool: 'run_skill_script', phase: 'input', value: { entrypoint: 'scripts/check.py' } },
  { tool: 'deploy_function_from_workspace', phase: 'input', value: { function_name: 'submit', trigger: { type: 'http' }, timeoutMs: 1000, memoryLimitMb: 128 } },
  { tool: 'list_pending_decisions', phase: 'result', value: { pending: [{ approval_id: 'apr_1', tool_name: 'deploy_frontend', raised_at: '2026-11-03T00:00:00Z', waiting: true }], count: 1 } },
  { tool: 'manage_storage', action: 'upload_url', phase: 'result', value: { objectId: '00000000-0000-4000-8000-000000000001', expiresIn: 300, _meta: { resource_info: { storage_used_bytes: 0, storage_limit_bytes: 1000, storage_used_percent: 0, files_count: 0 } } } },
  { tool: 'manage_billing', action: 'status', phase: 'result', value: { plan: { id: 'plan_example', name: 'Example' }, subscription: { id: 'sub_example', status: 'active', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, cancelAt: null, isCancelling: false }, aiCredits: { included: 10, used: 0, remaining: 10, overage: { spent: 0, cap: null, remaining: null, isAtCap: false } } } },
];

describe('actual tool contract fields in Office previews', () => {
  it.each(fixtures)('preserves $tool $action $phase metadata exactly', fixture => {
    const preview = previewOfficeToolValue(fixture.value, { toolName: fixture.tool, action: fixture.action, phase: fixture.phase });
    expect(preview.state).toBe('available');
    expect(JSON.parse(preview.text!)).toEqual(fixture.value);
  });
  it('retains new metadata while keeping DSL source and arbitrary nested configuration opaque', () => {
    const preview = previewOfficeToolValue({ schema: { tables: { orders: { columns: { id: { type: 'uuid', default: 'SECRET_ALPHA' } } } } },
      applied: 1, statements: [{ sql: 'SECRET_BETA', description: 'SECRET_GAMMA', destructive: false }] }, { toolName: 'manage_schema', action: 'dry_run', phase: 'result' });
    expect(preview.text).not.toContain('SECRET_');
    expect(JSON.parse(preview.text!).applied).toBe(1);
  });
  it('preserves reviewed index metadata and marks its column members beyond the depth bound', () => {
    const preview = previewOfficeToolValue({ schema: { tables: { orders: { indexes: { by_owner: { columns: ['owner_id'], unique: false, method: 'btree' } } } } } }, { toolName: 'manage_schema', action: 'dry_run', phase: 'input' });
    expect(JSON.parse(preview.text!)).toEqual({ schema: { tables: { orders: { indexes: { by_owner: { columns: ['[omitted: preview limit]'], unique: false, method: 'btree' } } } } } });
    expect(preview.truncated).toBe(true);
  });
  it('keeps credential-named boolean metadata withheld under the unchanged global rule', () => {
    const preview = previewOfficeToolValue({ requires_byo_credentials: false }, { toolName: 'manage_integrations', action: 'list_available', phase: 'result' });
    expect(JSON.parse(preview.text!)).toEqual({ requires_byo_credentials: '[withheld]' });
  });
  it('preserves bounded billing metadata without opening opaque provider or commercial data', () => {
    const preview = previewOfficeToolValue({ plan: { id: 'plan_example', raw_pricing: { amount: 'SECRET_ALPHA' } }, subscription: { status: 'active', provider_data: 'SECRET_BETA' }, clientSecret: 'SECRET_GAMMA' }, { toolName: 'manage_billing', action: 'status', phase: 'result' });
    expect(preview.text).not.toContain('SECRET_');
    expect(JSON.parse(preview.text!)).toMatchObject({ plan: { id: 'plan_example' }, subscription: { status: 'active' } });
  });
});
