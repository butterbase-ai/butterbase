/** Field policies describe display authority, never execution permission. */
export interface OfficePreviewContext { toolName: string; action?: string; capability?: string; phase: 'input' | 'result'; }
export type OfficePreviewClassification = 'structured' | 'secret' | 'url' | 'opaque';
export interface OfficeToolPreviewPathRule { path: string; classification: OfficePreviewClassification; }
export interface OfficeToolPreviewPolicy { input: readonly OfficeToolPreviewPathRule[]; result: readonly OfficeToolPreviewPathRule[]; }
export interface OfficePreviewPolicyProvider { resolve(context: OfficePreviewContext): OfficeToolPreviewPolicy | undefined; }
export const OFFICE_PREVIEW_POLICY_VERSION = 1;
const providers = new Set<OfficePreviewPolicyProvider>();
export function registerOfficePreviewPolicyProvider(provider: OfficePreviewPolicyProvider): void { providers.add(provider); }

const rules = (names: string, classification: OfficePreviewClassification = 'structured'): OfficeToolPreviewPathRule[] =>
  names.split(/\s+/).filter(Boolean).map(path => ({ path, classification: classification === 'structured'
    && /(?:^|\.)(?:url|api_url|websocket_url|authorization_url|token_url|userinfo_url|uploadUrl|downloadUrl|docs_url)$/.test(path) ? 'url' : classification }));

// Only these explicitly reviewed metadata leaves may survive inside approved containers.
// Unclassified parents stop this inheritance, even if a nested leaf has a familiar name.
const metadata = `id name title status state type kind action app_id organization_id tool_name capability
  created_at updated_at deleted_at started_at finished_at expires_at revision expected_revision enabled
  count total limit offset inserted failed row_index success successful valid requires_approval
  action_id approval_id decision_id memory_id source_artifact_id entity_id user_id resource_id
  next_cursor nextCursor nextOffset next_before hasMore has_more partial rejected retried cancelled
  error.code error.status code result_status result_phase duration_ms elapsed_ms version deleted revoked isError`;
const containers = `items rows result results decision decisions verdict error errors partial_errors details
  warnings data record records config configs metadata`;
const commonResult = [
  ...rules(metadata.split(/\s+/).map(key => `**.${key}`).join(' ')),
  ...rules(containers.split(/\s+/).map(key => `**.${key}`).join(' ')),
  ...rules('**.message **.remediation **.stack **.trace **.internal **.provider_metadata **.headers', 'opaque'),
];

/** Policy helper for reviewed overlay fields. It does not relax mandatory projector redaction. */
export function createOfficeToolPreviewPolicy(input: string, result = '', extra: { input?: readonly OfficeToolPreviewPathRule[]; result?: readonly OfficeToolPreviewPathRule[] } = {}): OfficeToolPreviewPolicy {
  return {
    input: [...rules(`action app_id organization_id org_id ${input}`), ...(extra.input ?? [])],
    result: [...commonResult, ...rules(result.split(/\s+/).filter(Boolean).map(key => `**.${key}`).join(' ')), ...(extra.result ?? [])],
  };
}

interface PolicyDecision { actions?: readonly string[]; policy: OfficeToolPreviewPolicy; variants?: Record<string, OfficeToolPreviewPolicy>; }
const decision = (input: string, result = '', actions?: string, extra?: Parameters<typeof createOfficeToolPreviewPolicy>[2]): PolicyDecision => ({
  actions: actions?.split(' '), policy: createOfficeToolPreviewPolicy(input, result, extra),
});

// Source: owned MCP handlers and local tool catalog. Action arrays intentionally stay
// independent of the registration schemas so coverage detects additions requiring review.
const publicDecisions: Record<string, PolicyDecision> = {
  init_app: decision('name region', 'name db_provisioned provisioning_status region subdomain api_url url apps'),
  list_regions: decision('', 'regions region name display_name available'),
  select_rows: decision('table select order limit offset as_role as_user query q filters filters.*', 'id title name status'),
  insert_row: decision('table as_role as_user data data.id data.title data.name data.status', 'id title name status'),
  seed_database: decision('table rows rows.* rows.*.id rows.*.title rows.*.name rows.*.status', 'id title name status'),
  query_audit_logs: decision('category event_type resource_type resource_id actor_id user_id from to limit offset', 'logs category event_type resource_type actor_id resource_id correlation_id success', undefined,
    { result: rules('**.event_data **.ip_address **.user_agent **.error_message', 'opaque') }),
  manage_api_keys: decision('key_id', 'keys key_prefix scopes scope substrate_organization_id last_used_at revoked key_id', 'list revoke'),
  manage_auth_config: decision('post_auth_function accessTokenTtl refreshTokenTtlDays name substrate_access key_scope additional_scopes additional_scopes.*', 'auth_hook_function jwt_config accessTokenTtl refreshTokenTtlDays keyId prefix name', 'configure_auth_hook update_jwt generate_service_key'),
  manage_auth_users: decision('user_id limit cursor', 'users provider email_verified last_sign_in_at deleted user_id', 'list delete'),
  manage_oauth: decision('provider client_id redirect_uris redirect_uris.* scopes scopes.* authorization_url token_url userinfo_url', 'provider client_id redirect_uris scopes authorization_url token_url userinfo_url enabled configs', 'configure get update delete'),
  manage_app: decision('paused reason access_mode visibility listed tables tables.* tables.*.table_name tables.*.user_column tables.*.public_read_column allowed_origins allowed_origins.* source_app_id name region substrate_organization_id substrate_autopropagate target_region job_id release_id version source_release_id force dry_run',
    'apps name region visibility listed db_provisioned provisioning_status paused paused_at access_mode allowed_origins storage_config auth_hook_function template_source_app_id fork_count substrate_organization_id substrate_autopropagate app_id job_id clone_job_id source_app_id target_app_id progress functions fn_name keys key_meta conventions durable_objects env_keys app_env tables_secured table_errors releases release_id source_release_id can_update',
    'list delete pause resume get_config update_access_mode secure update_cors set_visibility preview_clone_env_vars clone get_clone_job find_templates set_clone_webhook link_substrate unlink_substrate set_substrate_autopropagate move move_status teardown_source_replica get_env update_env publish_template_release list_template_releases get_template_release check_template_updates update_from_template'),
  manage_schema: decision('name schema schema.tables schema.tables.* schema.tables.*.name schema.tables.*.columns schema.tables.*.columns.* schema.tables.*.columns.*.name schema.tables.*.columns.*.type schema.tables.*.columns.*.nullable',
    'tables columns indexes migrations name type nullable primary_key table_name column_name applied_at api_base changes', 'get apply dry_run list_migrations'),
  manage_rls: decision('table_name action policy_name user_column public_read_column role command restrictive', 'policies tables policy_name table_name roles command permissive rls_enabled', 'enable create_policy update_policy create_user_isolation list delete'),
  manage_migrations: decision('', 'migrations migration_id progress source_region target_region phase table_count tables_copied replicas', 'get_active abort reverse list_source_replicas'),
  manage_storage: decision('filename content_type size_bytes public object_id publicReadEnabled storageLimitBytes maxFileSizeMb', 'objects objectId object_id filename content_type size_bytes public expiresIn maxSizeBytes url uploadUrl downloadUrl publicReadEnabled storageLimitBytes maxFileSizeMb', 'upload_url download_url list delete update_config'),
  manage_kv: decision('pattern read read.* write write.* prefix limit cursor confirm include_config key keys keys.* value value.id value.title value.name value.status ttl ephemeral raw touch by expected next entries entries.*.id entries.*.status',
    'key keys value values rules pattern read write ttl exists deleted count cursor next_cursor memory_bytes key_count',
    'list_rules expose unexpose stats scan flush get set del incr decr setnx setex cas exists ttl expire mget mset'),
  manage_realtime: decision('tables tables.*', 'tables configured table table_name trigger_installed drift active_connection websocket_url', 'configure get'),
  deploy_function: decision('name function_name timeoutMs memoryLimitMb auth_mode agent_tool agent_tool_mode agent_tool_exposed_to', 'function name url deployedAt deployment_id timeoutMs memoryLimitMb agent_tool agent_tool_mode'),
  manage_function: decision('function_name limit since level include_deleted allow_service_key_impersonation', 'functions name url triggers deployedAt lastInvoked lastStatus invocationCount errorRate avgDuration timeoutMs memoryLimitMb errorCount envKeys agent_tool agent_tool_mode agent_tool_exposed_to allow_service_key_impersonation', 'list get delete get_logs update_env update_settings'),
  invoke_function: decision('function_name method path', 'status statusCode duration_ms', undefined, { input: rules('body headers', 'opaque'), result: rules('body headers', 'opaque') }),
  create_frontend_deployment: decision('framework', 'deployment_id expiresIn maxSizeBytes uploadUrl'),
  manage_frontend: decision('deployment_id domain domain_action framework lockfile_hash output_dir package_manager', 'deployments deployment_id url framework domains domain verified file_count total_bytes', 'start_deployment list_deployments create_from_source start_from_source set_env configure_custom_domain'),
  manage_durable_objects: decision('name access_mode timeout_ms memory_mb key', 'classes name access_mode url version deployed_at requests duration_ms keys', 'deploy list get delete usage list_env set_env delete_env'),
  manage_edge_ssr: decision('name deployment_id enabled timeout_ms memory_mb framework lockfile_hash output_dir package_manager', 'name deployment_id url enabled deployment status timeout_ms memory_mb', 'create start list create_from_source start_from_source'),
  manage_ai: decision('model temperature max_tokens encoding_format dimensions job_id id size duration aspect_ratio duration_minutes transcript bot_name output_format forward_url rotate_secret limit cursor',
    'models model usage prompt_tokens completion_tokens total_tokens job_id image_id video_id bot_id meeting_id bots dimension seconds usd usd_charged creditsConsumed usdCharged cached expires_at content_type duration duration_minutes width height config defaultModel monthlyTokenLimit enabled byokEnabled',
    'chat embed decide list_models get_config update_config get_usage submit_video poll_video submit_image poll_image start_meeting get_meeting list_meetings stop_meeting estimate_meeting configure_meetings_webhook usage_meetings',
    { input: rules('messages input state questions prompt meeting_url provider_metadata', 'opaque'), result: rules('**.messages **.choices **.embeddings **.embedding **.output **.provider_metadata **.meeting_url **.recording_url **.transcript_url **.content', 'opaque') }),
  manage_agents: decision('name enabled model timeout_ms max_iterations', 'agents agent name enabled model valid issues invocationCount runs run_id', 'list get create update delete validate', { input: rules('graph_spec', 'opaque'), result: rules('**.graph_spec **.note', 'opaque') }),
  manage_integrations: decision('toolkit scopes scopes.* display_name search tool_name user_id', 'integrations connections toolkit toolkit_slug displayName display_name enabled scopes connected_at last_used_at successful', 'configure rotate_credentials disable list_available list_connected list_tools execute_action execute_read',
    { input: rules('oauth_credentials params config', 'opaque'), result: rules('data tools parameters', 'opaque') }),
  manage_people: decision('current_role_title past_role_title current_company_name current_company_industry country region city education_school_name education_degree_name education_field_of_study page_size enrich_profiles industry employee_count_max linkedin_profile_url live_fetch id', 'usage lookupId credits_consumed creditsConsumed usdCharged cached', 'search_person search_company get_profile queue_email_lookup get_email_lookup set_byok_key clear_byok_key', { result: rules('data email', 'opaque') }),
  manage_rag_content: decision('name description chunkSize overlap access collection storage_object_id filename document_id', 'documentId document_id collection collection_name filename content_type source_type chunk_count document_counts chunkSize overlap access', 'create_collection list_collections get_collection delete_collection ingest_document list_documents get_document_status delete_document'),
  rag_query: decision('collection query topK top_k limit threshold include_metadata filter filter.*', 'matches score document document_id filename content_type chunk_id rank count', undefined, { result: rules('**.content **.text', 'opaque') }),
  manage_repo: decision('snapshot_id files files.* files.*.path', 'snapshot_id snapshots path sha256 size file_count total_bytes remote_latest_snapshot_id files downloadUrl', 'push pull_latest pull_snapshot status list_snapshots wipe', { input: rules('message files.*.content files.*.base64', 'opaque') }),
  manage_preview: decision('', 'preview_id previews name source_app_id deployment_id url expires_at can_promote changes', 'create status reset get_env_overrides set_env_overrides'),
  promote_preview: decision('', 'can_promote checks preview_id deployment_id url promoted', 'check run'),
  manage_billing: decision('amount raise_by start_date end_date meter', 'amount capUsd overageSpentUsd remainingUsd isAtCap newCap previousCap startDate endDate usage date quantity accountStatus billingPeriodStart credits monthly_allowance_usd topup_usd total_usd', 'status portal topup cap_get cap_raise plans usage', { result: rules('url plan plans subscription aiCredits aiUsageBreakdown topupBalance usagePercentages', 'opaque') }),
  butterbase_docs: decision('topic query', '', undefined),
  list_partner_apis: decision('hackathon_slug', 'slug display_name status docs_url proxy_url_template'),
  prep_and_submit_hackathon_entry: decision('hackathon_slug', 'matched slug field_schema data_required submitted entry_id', 'prep submit', { input: rules('data submission_code', 'opaque') }),
  submit_suggestion: decision('category severity affected_tool source', 'suggestion category severity affected_tool source status', undefined, { input: rules('description proposed_solution agent_context', 'opaque') }),
  read_operator_scratchpad: decision('', 'revision updated_at'),
  update_operator_scratchpad: decision('expected_revision', 'revision updated_at'),
  write_file: decision('path', 'path bytes size written'), read_file: decision('path', 'path bytes size'),
  list_files: decision('path prefix', 'files path size bytes'), delete_file: decision('path', 'path deleted'),
  deploy_frontend: decision('framework', 'deployment_id url status file_count'),
  deploy_function_from_workspace: decision('function_name entrypoint timeoutMs memoryLimitMb', 'function_name deployment_id url status'),
  run_sandbox_code: decision('language timeout_ms', 'exit_code duration_ms status'),
  build_app: decision('app_id framework', 'success status duration_ms file_count'),
  list_pending_decisions: decision('limit cursor status', 'decisions action_id approval_id title status'),
  skill_creator: decision('skill_id version', 'skill_id version revision status'),
  run_skill_script: decision('skill_id script_id version', 'skill_id script_id version status exit_code'),
  propose_action: decision('summary rationale operation operation.tool_name operation.action operation.capability operation.arguments', 'approval_id action_id status requires_approval proposal duplicate', undefined),
};

export const PUBLIC_OFFICE_PREVIEW_TOOL_NAMES = Object.freeze(Object.keys(publicDecisions).sort());
export const PUBLIC_OFFICE_PREVIEW_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  Object.entries(publicDecisions).map(([name, entry]) => [name, entry.actions ?? []]),
));
export function resolveOfficePreviewPolicy(context: OfficePreviewContext): OfficeToolPreviewPolicy | undefined {
  for (const provider of providers) {
    try { const policy = provider.resolve(context); if (policy) return policy; } catch { /* Optional policy failures withhold instead of breaking execution. */ }
  }
  const entry = Object.hasOwn(publicDecisions, context.toolName) ? publicDecisions[context.toolName] : undefined;
  if (!entry) return undefined;
  if (context.action && entry.actions && !entry.actions.includes(context.action)) {
    // Unknown dispatch variants have no authority to disclose their new fields.
    return createOfficeToolPreviewPolicy('');
  }
  return entry.variants?.[context.action ?? ''] ?? entry.policy;
}

/** A segment wildcard never matches an object's literal dot-containing key. */
export function classifyOfficePreviewPath(policy: OfficeToolPreviewPolicy | undefined, phase: OfficePreviewContext['phase'], path: readonly string[]): OfficePreviewClassification | undefined {
  let found: OfficePreviewClassification | undefined;
  for (const rule of policy?.[phase] ?? []) {
    const parts = rule.path.split('.');
    const offset = parts[0] === '**' ? path.length - (parts.length - 1) : 0;
    if (offset < 0 || (parts[0] !== '**' && parts.length !== path.length)) continue;
    const match = (parts[0] === '**' ? parts.slice(1) : parts).every((part, index) => part === '*' || part === path[offset + index]);
    if (match) found = rule.classification;
  }
  return found;
}
