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
const schemaMetadata = `schema schema.tables schema.tables.* schema.tables.*.columns schema.tables.*.columns.*
  schema.tables.*.columns.*.type schema.tables.*.columns.*.primaryKey schema.tables.*.columns.*.nullable
  schema.tables.*.columns.*.unique schema.tables.*.columns.*.references schema.tables.*.columns.*.references.table
  schema.tables.*.columns.*.references.column schema.tables.*.columns.*.references.onDelete schema.tables.*.columns.*.references.onUpdate
  schema.tables.*.indexes schema.tables.*.indexes.* schema.tables.*.indexes.*.columns schema.tables.*.indexes.*.columns.*
  schema.tables.*.indexes.*.unique schema.tables.*.indexes.*.method schema.tables.*.indexes.*.opclass
  schema.tables.*._seed schema.tables.*._dropColumns schema.tables.*._dropColumns.* schema._drop schema._drop.*`;
const agentSettings = `name display_name default_model status visibility max_runs_per_user_per_hour max_runs_per_ip_per_hour
  max_runs_per_app_per_hour daily_budget_usd max_concurrent_runs safety_acknowledged`;
const buildDeploymentMetadata = `deployments deployment_id build_id framework url max_source_bytes expiresIn fileCount totalSizeBytes
  createdAt startedAt completedAt updatedAt`;
const triggerInput = 'trigger trigger.type triggers triggers.* triggers.*.type triggers.*.enabled';
const scalarArrayRules = (paths: string) => rules(paths.split(/\s+/).filter(Boolean).map(path => `${path}.*`).join(' '));

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
  manage_app: decision('paused reason access_mode visibility listed tables tables.* tables.*.table_name tables.*.user_column tables.*.public_read_column allowed_origins allowed_origins.* source_app_id name region job_id clear_webhook webhook_url q sort limit offset label release_number users dest_region migration_id',
    'apps name region visibility listed db_provisioned provisioning_status paused paused_at access_mode allowed_origins storage_config auth_hook_function template_source_app_id fork_count substrate_organization_id substrate_autopropagate app_id job_id source_app_id dest_app_id dest_region dest_region_redirected_from retry_count completed_at clone_webhook_configured webhook_url linked current_step migration_id source_region source_replica_state step_started_at functions fn_name keys key_meta conventions durable_objects env_keys app_env tables_secured table_errors releases release_number label snapshot_id published_at table_count function_names required_env updated_keys invalidated durable_objects_redeployed is_fork severed behind_by divergence forks repo frontend schema rls has_backend_base current behind_unmodified behind_modified unknown degraded_regions mode target_release_number',
    'list delete pause resume get_config update_access_mode secure update_cors set_visibility preview_clone_env_vars clone get_clone_job find_templates set_clone_webhook link_substrate unlink_substrate set_substrate_autopropagate move move_status teardown_source_replica get_env update_env publish_template_release list_template_releases get_template_release check_template_updates update_from_template',
    { result: [...scalarArrayRules('updated_keys function_names required_env'),
      ...rules('pending_env_vars pending_env_vars.* pending_env_vars.*.* unfilled_env_vars unfilled_env_vars.* unfilled_env_vars.*.*'),
      ...rules('**.notes **.manifest **.progress **.last_error **.error_message', 'opaque')] }),
  manage_schema: decision(`name ${schemaMetadata}`,
    'schema applied dry_run statements destructive migrations migration_id template_migrations filename applied_at api_base', 'get apply dry_run list_migrations',
    { input: rules('**.default **.sql **.description', 'opaque'), result: [...rules(schemaMetadata), ...rules('**.default **.sql **.description **.applied_sql', 'opaque')] }),
  manage_rls: decision('table_name policy_name user_column public_read_column role command restrictive', 'policies table policy_name user_column public_read_policies tables_with_rls schemaname tablename policyname roles cmd permissive rls_enabled remaining_policies policies_removed', 'enable create_policy update_policy create_user_isolation list delete',
    { result: [...scalarArrayRules('tables_with_rls'), ...rules('**.qual **.with_check', 'opaque')] }),
  manage_migrations: decision('migration_id', 'migration migration_id migrationId path current_step source_region dest_region source_replica_state step_started_at source_replicas completed_at estimated_monthly_cost_usd', 'get_active abort reverse list_source_replicas'),
  manage_storage: decision('filename content_type size_bytes public object_id publicReadEnabled storageLimitBytes maxFileSizeMb', 'objects objectId object_id filename content_type size_bytes public expiresIn maxSizeBytes url uploadUrl downloadUrl publicReadEnabled storageLimitBytes maxFileSizeMb', 'upload_url download_url list delete update_config',
    { result: rules('_meta _meta.resource_info _meta.resource_info.storage_used_bytes _meta.resource_info.storage_limit_bytes _meta.resource_info.storage_used_percent _meta.resource_info.files_count') }),
  manage_kv: decision('pattern read read.* write write.* prefix limit cursor confirm include_config key keys keys.* value value.id value.title value.name value.status ttl ephemeral raw touch by expected next entries entries.*.id entries.*.status',
    'key keys value values rules pattern read write order ttl exists deleted count cursor wrote swapped applied ok keys_total bytes_used ops_per_sec max_keys max_storage_bytes max_ops_per_sec max_value_bytes existing',
    'list_rules expose unexpose stats scan flush get set del incr decr setnx setex cas exists ttl expire mget mset'),
  manage_realtime: decision('tables tables.*', 'tables configured table table_name trigger_installed drift active_connection websocket_url', 'configure get'),
  deploy_function: decision(`name timeoutMs memoryLimitMb envVarsReplace allow_service_key_impersonation agent_tool agent_tool_mode agent_tool_exposed_to ${triggerInput}`, 'name url deployedAt triggers cacheInvalidation attempts timeoutMs memoryLimitMb agent_tool agent_tool_mode agent_tool_exposed_to', undefined,
    { input: rules('**.config **.description **.agent_tool_description', 'opaque'), result: rules('**.config **.description **.agent_tool_description', 'opaque') }),
  manage_function: decision('function_name limit since level include_deleted allow_service_key_impersonation', 'functions function function_name name url triggers deployedAt lastInvoked lastStatus invocationCount errorRate avgDuration timeoutMs memoryLimitMb errorCount envKeys agent_tool agent_tool_mode agent_tool_exposed_to allow_service_key_impersonation updatedKeys cache_invalidation attempts', 'list get delete get_logs update_env update_settings',
    { result: [...scalarArrayRules('updatedKeys'), ...rules('**.triggers.*.config **.description **.agent_tool_description', 'opaque')] }),
  invoke_function: decision('function_name method path', 'status statusCode duration_ms', undefined, { input: rules('body headers', 'opaque'), result: rules('body headers', 'opaque') }),
  create_frontend_deployment: decision('framework', 'deployment_id expiresIn maxSizeBytes uploadUrl'),
  manage_frontend: decision('deployment_id domain_action hostname domain_id validation_method framework lockfile_hash output_dir package_manager', `${buildDeploymentMetadata} keys domains domain domain_id hostname ssl_status cname_target validation_method`, 'start_deployment list_deployments create_from_source start_from_source set_env configure_custom_domain',
    { result: rules('**.verification_records **.ownership_verification **.instructions **.verification_errors', 'opaque') }),
  manage_durable_objects: decision('name access_mode key', 'durable_objects name class_name access_mode last_deployed_at do_requests do_cpu_ms keys redeployed', 'deploy list get delete usage list_env set_env delete_env'),
  manage_edge_ssr: decision('deployment_id framework limit lockfile_hash output_dir package_manager', `${buildDeploymentMetadata} workerScriptSizeBytes workerScriptModuleCount`, 'create start list create_from_source start_from_source'),
  manage_ai: decision(`model temperature max_tokens encoding_format job_id size duration resolution aspect_ratio generate_audio seed n
    modality startDate endDate config config.defaultModel config.defaultDecisionModel config.maxTokensPerRequest config.allowedModels config.allowedModels.*
    prepare_references reference_declarations reference_declarations.* reference_declarations.*.path reference_declarations.*.kind
    meeting_id status recording duration_minutes transcript bot_name forward_url rotate_secret limit cursor automatic_leave
    automatic_leave.waiting_room_timeout_sec automatic_leave.no_one_joined_timeout_sec automatic_leave.everyone_left_timeout_sec automatic_leave.in_call_not_recording_timeout_sec`,
    'models model context_length modality usage prompt_tokens completion_tokens total_tokens job_id stage charged_credits_usd settled_at meeting_id bots dimension seconds usd usd_charged expires_at config defaultModel defaultDecisionModel maxTokensPerRequest allowedModels totalTokens totalCost byModel byModality meetings cost requests startedAt completedAt durationSeconds botName ok forward_url',
    'chat embed decide list_models get_config update_config get_usage submit_video poll_video submit_image poll_image start_meeting get_meeting list_meetings stop_meeting estimate_meeting configure_meetings_webhook usage_meetings',
    { input: rules('messages input state questions prompt meeting_url provider_metadata', 'opaque'), result: [
      ...scalarArrayRules('config.allowedModels'), ...rules('byModel.* byModel.*.cost byModel.*.requests byModality.* byModality.*.cost byModality.*.requests'),
      ...rules('**.messages **.choices **.embeddings **.embedding **.output **.provider_metadata **.meeting_url **.recording_url **.transcript_url **.recordingUrl **.transcriptUrl **.content', 'opaque'),
    ] }),
  manage_agents: decision(agentSettings, `agents agent ${agentSettings} valid issues`, 'list get create update delete validate', { input: rules('graph_spec description', 'opaque'), result: rules('**.graph_spec **.note **.description', 'opaque') }),
  manage_integrations: decision('toolkit scopes scopes.* display_name search tool_name tool_slug user_id', 'integrations connections toolkit toolkit_slug displayName display_name enabled scopes connected_at last_used_at successful curated auth_schemes requires_byo_credentials tools', 'configure rotate_credentials disable list_available list_connected list_tools execute_action execute_read',
    { input: rules('oauth_credentials params config', 'opaque'), result: [...scalarArrayRules('**.auth_schemes'), ...rules('data **.parameters **.tools.*.description', 'opaque')] }),
  manage_people: decision('current_role_title past_role_title current_company_name current_company_industry country region city education_school_name education_degree_name education_field_of_study page_size enrich_profiles industry employee_count_max linkedin_profile_url live_fetch id', 'usage lookupId credits_consumed creditsConsumed usdCharged cached', 'search_person search_company get_profile queue_email_lookup get_email_lookup set_byok_key clear_byok_key', { result: rules('data email', 'opaque') }),
  manage_rag_content: decision('name description chunk_size chunk_overlap access_mode collection storage_object_id filename document_id', 'documentId document_id collection collection_name filename content_type source_type chunk_count document_counts chunk_size chunk_overlap access_mode', 'create_collection list_collections get_collection delete_collection ingest_document list_documents get_document_status delete_document',
    { result: rules('document_counts.pending document_counts.processing document_counts.ready document_counts.failed') }),
  rag_query: decision('collection query top_k threshold synthesize model filter filter.*', 'chunks matches score document document_id filename content_type chunk_id rank count model usage prompt_tokens completion_tokens total_tokens', undefined, { result: rules('**.content **.text **.answer', 'opaque') }),
  manage_repo: decision('snapshot_id files files.* files.*.path', 'snapshot_id snapshots path sha256 size file_count total_bytes remote_latest_snapshot_id files downloadUrl', 'push pull_latest pull_snapshot status list_snapshots wipe', { input: rules('message files.*.content files.*.base64', 'opaque') }),
  manage_preview: decision('', 'job_id staging_name staging_subdomain staging_app_id region last_job mode keys applied_to_staging last_promoted_at last_reset_at paused paused_at invalidated functions failed count durable_objects_redeployed', 'create status reset get_env_overrides set_env_overrides'),
  promote_preview: decision('', 'can_promote job_id', 'check run'),
  manage_billing: decision('amount raise_by start_date end_date meter', 'amount capUsd overageSpentUsd remainingUsd isAtCap newCap previousCap startDate endDate usage date quantity accountStatus billingPeriodStart credits monthly_allowance_usd topup_usd total_usd', 'status portal topup cap_get cap_raise plans usage', { result: [
    ...rules('url plans aiUsageBreakdown topupBalance usagePercentages', 'opaque'),
    ...rules(`plan plan.id plan.name subscription subscription.id subscription.status subscription.currentPeriodStart subscription.currentPeriodEnd
      subscription.cancelAtPeriodEnd subscription.cancelAt subscription.isCancelling aiCredits aiCredits.included aiCredits.used aiCredits.remaining
      aiCredits.overage aiCredits.overage.spent aiCredits.overage.cap aiCredits.overage.remaining aiCredits.overage.isAtCap`),
    ...rules('**.raw_pricing **.provider_data **.overageRates **.rate', 'opaque'),
  ] }),
  butterbase_docs: decision('topic query', '', undefined),
  list_partner_apis: decision('hackathon_slug', 'slug display_name status docs_url proxy_url_template'),
  prep_and_submit_hackathon_entry: decision('hackathon_slug', 'matched slug match_reason open_hackathons submission_deadline starts_at ends_at submission hackathon_slug participant_created', 'prep submit', { input: rules('data submission_code', 'opaque'), result: rules('**.field_schema **.next_call **.submission.data', 'opaque') }),
  submit_suggestion: decision('category severity affected_tool source', 'suggestion category severity affected_tool source status', undefined, { input: rules('description proposed_solution agent_context', 'opaque') }),
  read_operator_scratchpad: decision('', 'format updated_at'),
  update_operator_scratchpad: decision('', 'ok characters updated_at'),
  write_file: decision('path', 'path sha256 size'), read_file: decision('path', 'path'),
  list_files: decision('', 'files path size'), delete_file: decision('path', 'path'),
  deploy_frontend: decision('', 'deployment_id url'),
  deploy_function_from_workspace: decision('function_name timeoutMs memoryLimitMb trigger trigger.type', 'deployment_id url', undefined, { input: rules('trigger.config', 'opaque') }),
  run_sandbox_code: decision('', ''),
  build_app: decision('', 'ok step exit_code install_skipped dependency_cache_hit baked_modules output_truncated timed_out duration_ms files_built'),
  list_pending_decisions: decision('', 'pending approval_id tool_name raised_at waiting', undefined, { result: rules('**.tool_args', 'opaque') }),
  skill_creator: decision('target_skill_id draft_version_id timezone', 'skill_id version_id version test_run_id status', undefined, { input: rules('request', 'opaque'), result: rules('**.summary **.change_summary', 'opaque') }),
  run_skill_script: decision('entrypoint', 'exit_code', undefined, { input: rules('input', 'opaque') }),
  propose_action: decision('reason operation operation.tool operation.arguments evidence_refs evidence_refs.* evidence_refs.*.kind evidence_refs.*.id evidence_refs.*.app_id evidence_refs.*.object_id evidence_refs.*.conversation_id evidence_refs.*.message_id', 'approval_id action_id status requires_approval proposal duplicate', undefined),
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
