-- @scope: runtime
-- Initial runtime-tier schema. Snapshot of the runtime tables from the unified
-- control DB at Phase 2 cutover time. Subsequent runtime-scoped migrations live
-- in db/runtime-plane/002_*.sql and onward.
--
-- FK constraints to platform-tier tables (platform_users, api_keys, hackathons)
-- are DROPPED here — those become logical FKs per the multi-region spec.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: partner_pools_set_updated_at; Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.partner_pools_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

--
-- Name: agent_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_checkpoints (
    run_id uuid NOT NULL,
    step integer NOT NULL,
    node_id text NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_mcp_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    transport text NOT NULL,
    url text NOT NULL,
    auth_header text,
    tool_acl jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_health timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_mcp_servers_transport_check CHECK ((transport = ANY (ARRAY['http'::text, 'sse'::text, 'streamable_http'::text])))
);


--
-- Name: agent_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_events (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_run_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_run_events_id_seq OWNED BY public.agent_run_events.id;


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    agent_id uuid NOT NULL,
    caller_kind text NOT NULL,
    caller_user_id text,
    status text DEFAULT 'queued'::text NOT NULL,
    input jsonb NOT NULL,
    output jsonb,
    error jsonb,
    interrupt_payload jsonb,
    webhook_url text,
    idempotency_key text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat timestamp with time zone,
    cancel_requested boolean DEFAULT false NOT NULL,
    resume_input jsonb,
    attempt integer DEFAULT 0 NOT NULL,
    caller_ip inet,
    payload_hash bytea,
    CONSTRAINT agent_runs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'cancelling'::text, 'cancelled'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: agent_tool_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_audits (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    app_id text NOT NULL,
    tool_source text NOT NULL,
    tool_name text NOT NULL,
    server_id uuid,
    args_hash text NOT NULL,
    duration_ms integer NOT NULL,
    status text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tool_audits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_tool_audits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_tool_audits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_tool_audits_id_seq OWNED BY public.agent_tool_audits.id;


--
-- Name: agent_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_usage (
    run_id uuid NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    tool_call_count integer DEFAULT 0 NOT NULL,
    cost_usd_cents integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_webhook_deliveries (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    payload jsonb,
    CONSTRAINT agent_webhook_deliveries_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: agent_webhook_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_webhook_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_webhook_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_webhook_deliveries_id_seq OWNED BY public.agent_webhook_deliveries.id;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    display_name text,
    description text,
    graph_spec jsonb NOT NULL,
    default_model text,
    byok_override text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    max_runs_per_user_per_hour integer,
    max_runs_per_ip_per_hour integer,
    max_runs_per_app_per_hour integer,
    daily_budget_usd numeric(10,4),
    max_concurrent_runs integer,
    safety_acknowledged boolean DEFAULT false NOT NULL,
    CONSTRAINT agents_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'authenticated'::text, 'public'::text])))
);


--
-- Name: ai_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    model text NOT NULL,
    provider text NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10,6),
    request_metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_type text DEFAULT 'platform'::text,
    charged_to_user boolean DEFAULT false
);


--
-- Name: app_connected_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_connected_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    app_user_id uuid NOT NULL,
    toolkit_slug text NOT NULL,
    composio_account_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT app_connected_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'expired'::text])))
);


--
-- Name: app_custom_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_custom_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    hostname text NOT NULL,
    cf_custom_hostname_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    ssl_status text DEFAULT 'pending'::text NOT NULL,
    verification_type text,
    verification_value text,
    verification_errors jsonb,
    domain_type text DEFAULT 'frontend'::text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_db_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_db_connections (
    app_id text NOT NULL,
    connection_string text NOT NULL,
    pooler_connection_string text,
    neon_project_id text,
    neon_database_name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_do_deploy_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_do_deploy_state (
    app_id text NOT NULL,
    deployed_class_names text[] DEFAULT '{}'::text[] NOT NULL,
    bundle_sha text,
    deployed_at timestamp with time zone,
    migration_tag text
);


--
-- Name: app_do_env_vars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_do_env_vars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    key character varying(100) NOT NULL,
    encrypted_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_durable_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_durable_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    class_name text NOT NULL,
    code text NOT NULL,
    code_sha text NOT NULL,
    access_mode text DEFAULT 'authenticated'::text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    error_message text,
    last_deployed_at timestamp with time zone,
    deployed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_durable_objects_access_mode_check CHECK ((access_mode = ANY (ARRAY['public'::text, 'authenticated'::text, 'service_key'::text]))),
    CONSTRAINT app_durable_objects_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'BUILDING'::text, 'READY'::text, 'ERROR'::text, 'SUPERSEDED'::text])))
);


--
-- Name: app_edge_ssr_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_edge_ssr_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    framework text NOT NULL,
    status text DEFAULT 'WAITING'::text NOT NULL,
    error_message text,
    r2_object_key text,
    upload_expires_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    file_count integer,
    total_size_bytes bigint,
    worker_script_size_bytes bigint,
    worker_script_module_count integer,
    deployment_url text,
    env_vars_stale boolean DEFAULT false NOT NULL,
    deployed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_edge_ssr_deployments_framework_check CHECK ((framework = ANY (ARRAY['nextjs-edge'::text, 'remix-edge'::text, 'other-edge'::text]))),
    CONSTRAINT app_edge_ssr_deployments_status_check CHECK ((status = ANY (ARRAY['WAITING'::text, 'UPLOADING'::text, 'BUILDING'::text, 'READY'::text, 'ERROR'::text, 'CANCELED'::text, 'SUPERSEDED'::text])))
);


--
-- Name: app_frontend_env_vars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_frontend_env_vars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    key character varying(100) NOT NULL,
    encrypted_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_functions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_functions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    code text NOT NULL,
    encrypted_env_vars text,
    timeout_ms integer DEFAULT 30000 NOT NULL,
    memory_limit_mb integer DEFAULT 128 NOT NULL,
    deployed_at timestamp with time zone DEFAULT now() NOT NULL,
    deployed_by uuid,
    last_invoked_at timestamp with time zone,
    invocation_count bigint DEFAULT 0 NOT NULL,
    error_count bigint DEFAULT 0 NOT NULL,
    avg_duration_ms numeric(10,2),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_tool boolean DEFAULT false NOT NULL,
    agent_tool_description text,
    agent_tool_mode text,
    agent_tool_exposed_to text,
    last_status_code integer,
    trigger_type character varying(20) DEFAULT 'http'::character varying NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT app_functions_agent_tool_exposed_to_check CHECK ((agent_tool_exposed_to = ANY (ARRAY['developer_only'::text, 'end_user'::text]))),
    CONSTRAINT app_functions_agent_tool_mode_check CHECK ((agent_tool_mode = ANY (ARRAY['read_only'::text, 'read_write'::text])))
);


--
-- Name: app_integration_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_integration_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    toolkit_slug text NOT NULL,
    composio_auth_config_id text NOT NULL,
    display_name text,
    enabled boolean DEFAULT true NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_oauth_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_oauth_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    provider text NOT NULL,
    client_id text,
    client_secret_encrypted text,
    scopes text[],
    authorization_url text,
    token_url text,
    userinfo_url text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    redirect_uris text[] DEFAULT '{}'::text[],
    provider_metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: COLUMN app_oauth_configs.redirect_uris; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_oauth_configs.redirect_uris IS 'Whitelist of allowed redirect URIs for OAuth';


--
-- Name: app_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    stripe_checkout_session_id text NOT NULL,
    stripe_payment_intent_id text,
    amount_cents integer NOT NULL,
    platform_fee_cents integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    refunded_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    price_cents integer NOT NULL,
    "interval" text DEFAULT 'month'::text NOT NULL,
    features jsonb DEFAULT '[]'::jsonb,
    stripe_price_id text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    description text,
    price_cents integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    active boolean DEFAULT true,
    stripe_product_id text,
    stripe_price_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_products_price_cents_check CHECK ((price_cents >= 0))
);


--
-- Name: app_realtime_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_realtime_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    table_name text NOT NULL,
    events text[] DEFAULT ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text],
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_signing_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_signing_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    kid text NOT NULL,
    algorithm text DEFAULT 'RS256'::text NOT NULL,
    private_key_encrypted text NOT NULL,
    public_key text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    stripe_subscription_id text,
    stripe_customer_id text,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grace_period_ends_at timestamp with time zone
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    email text NOT NULL,
    password_hash text,
    provider text DEFAULT 'email'::text,
    provider_uid text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    display_name text,
    avatar_url text,
    last_sign_in_at timestamp with time zone
);


--
-- Name: app_verification_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_verification_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id text NOT NULL,
    name text NOT NULL,
    owner_id uuid NOT NULL,
    db_name text NOT NULL,
    db_provisioned boolean DEFAULT false NOT NULL,
    region text DEFAULT 'local'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_origins text[] DEFAULT '{http://localhost:3000}'::text[],
    storage_config jsonb DEFAULT '{"maxFileSizeMb": 10, "publicReadEnabled": false, "allowedContentTypes": ["*/*"]}'::jsonb,
    jwt_config jsonb DEFAULT '{"accessTokenTtl": "15m", "refreshTokenTtlDays": 7}'::jsonb,
    subdomain text,
    stripe_connect_account_id text,
    ai_config jsonb DEFAULT '{}'::jsonb,
    deployment_url text,
    last_deployed_at timestamp with time zone,
    cloudflare_project_name text,
    provisioning_status text DEFAULT 'provisioning'::text NOT NULL,
    provisioning_error text,
    deployment_backend text DEFAULT 'pages'::text NOT NULL,
    auth_hook_function text,
    access_mode text DEFAULT 'public'::text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    paused_at timestamp with time zone,
    paused_reason text,
    anon_key text DEFAULT encode(public.gen_random_bytes(32), 'base64'::text) NOT NULL,
    CONSTRAINT apps_deployment_backend_check CHECK ((deployment_backend = ANY (ARRAY['pages'::text, 'wfp'::text]))),
    CONSTRAINT apps_provisioning_status_check CHECK ((provisioning_status = ANY (ARRAY['provisioning'::text, 'ready'::text, 'failed'::text, 'deleting'::text])))
);


--
-- Name: COLUMN apps.allowed_origins; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apps.allowed_origins IS 'Whitelist of allowed CORS origins';


--
-- Name: COLUMN apps.jwt_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apps.jwt_config IS 'JWT token configuration: accessTokenTtl (e.g., "15m", "1h", "2h"), refreshTokenTtlDays (integer)';


--
-- Name: COLUMN apps.ai_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apps.ai_config IS 'JSONB config. byokKey should be encrypted with AES-256-GCM format (iv:ciphertext:authTag)';


--
-- Name: COLUMN apps.auth_hook_function; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apps.auth_hook_function IS 'Name of a deployed Butterbase function to invoke after successful auth events. Fire-and-forget.';


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    category text NOT NULL,
    event_type text NOT NULL,
    action text,
    resource_type text,
    resource_id text,
    actor_type text NOT NULL,
    actor_id text,
    event_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip_address inet,
    user_agent text,
    success boolean NOT NULL,
    error_message text,
    correlation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE audit_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_events IS 'Unified audit trail: auth events, admin mutations, function invocations';


--
-- Name: dispatcher_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatcher_cursors (
    name text NOT NULL,
    "position" text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dispatcher_cursors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dispatcher_cursors IS 'Persistent cursors for ordered-read dispatchers (e.g. storage upload events).';


--
-- Name: function_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.function_invocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    function_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    method character varying(10),
    path text,
    headers jsonb,
    request_body_size_bytes integer,
    status_code integer,
    response_body_size_bytes integer,
    duration_ms integer,
    memory_used_mb numeric(10,2),
    error_message text,
    error_stack text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    billed_duration_ms integer,
    billed_memory_mb integer,
    console_logs jsonb,
    trigger_type character varying(20),
    source_event_id text,
    attempt_count integer DEFAULT 1 NOT NULL,
    next_retry_at timestamp with time zone,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL
);


--
-- Name: function_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.function_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    function_id uuid NOT NULL,
    app_id text NOT NULL,
    trigger_type character varying(20) NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE function_triggers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.function_triggers IS 'Triggers attached to a function. A function can have multiple triggers (e.g. cron + http) but at most one of each type.';


--
-- Name: mcp_tool_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tool_call_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_key_id uuid,
    user_id uuid,
    tool_name text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb,
    app_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_states (
    state text NOT NULL,
    app_id text NOT NULL,
    provider text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    redirect_to text,
    code_verifier text
);


--
-- Name: TABLE oauth_states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_states IS 'Temporary storage for OAuth state tokens (CSRF protection)';


--
-- Name: COLUMN oauth_states.redirect_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oauth_states.redirect_to IS 'Frontend URL to redirect to after successful OAuth authentication';


--
-- Name: partner_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pool_id uuid NOT NULL,
    encrypted_key text NOT NULL,
    label text,
    status text DEFAULT 'active'::text NOT NULL,
    last_used_at timestamp with time zone,
    last_failed_at timestamp with time zone,
    last_failure_status integer,
    last_failure_body text,
    failure_count integer DEFAULT 0 NOT NULL,
    use_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_prefix text,
    CONSTRAINT partner_keys_status_check CHECK ((status = ANY (ARRAY['active'::text, 'exhausted'::text, 'revoked'::text])))
);


--
-- Name: partner_pools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_pools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hackathon_id uuid NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    base_url text NOT NULL,
    auth_template jsonb NOT NULL,
    contact_message text DEFAULT 'Contact the hackathon host for additional access.'::text NOT NULL,
    docs_url text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_proxy_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_proxy_logs (
    id bigint NOT NULL,
    pool_id uuid NOT NULL,
    key_id uuid,
    app_id text,
    user_id uuid,
    method text NOT NULL,
    path text NOT NULL,
    status_code integer,
    bytes_in bigint,
    bytes_out bigint,
    latency_ms integer,
    failover_attempts integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_proxy_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.partner_proxy_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: partner_proxy_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.partner_proxy_logs_id_seq OWNED BY public.partner_proxy_logs.id;


--
-- Name: storage_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    bucket text NOT NULL,
    key text NOT NULL,
    size_bytes bigint,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    filename text,
    content_type text,
    public boolean DEFAULT false NOT NULL
);


--
-- Name: agent_run_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events ALTER COLUMN id SET DEFAULT nextval('public.agent_run_events_id_seq'::regclass);


--
-- Name: agent_tool_audits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audits ALTER COLUMN id SET DEFAULT nextval('public.agent_tool_audits_id_seq'::regclass);


--
-- Name: agent_webhook_deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_webhook_deliveries ALTER COLUMN id SET DEFAULT nextval('public.agent_webhook_deliveries_id_seq'::regclass);


--
-- Name: partner_proxy_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_proxy_logs ALTER COLUMN id SET DEFAULT nextval('public.partner_proxy_logs_id_seq'::regclass);


--
-- Name: agent_checkpoints agent_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_checkpoints
    ADD CONSTRAINT agent_checkpoints_pkey PRIMARY KEY (run_id, step);


--
-- Name: agent_mcp_servers agent_mcp_servers_app_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_app_id_name_key UNIQUE (app_id, name);


--
-- Name: agent_mcp_servers agent_mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: agent_run_events agent_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_pkey PRIMARY KEY (id);


--
-- Name: agent_run_events agent_run_events_run_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_run_id_seq_key UNIQUE (run_id, seq);


--
-- Name: agent_runs agent_runs_app_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_app_id_idempotency_key_key UNIQUE (app_id, idempotency_key);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_audits agent_tool_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audits
    ADD CONSTRAINT agent_tool_audits_pkey PRIMARY KEY (id);


--
-- Name: agent_usage agent_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_pkey PRIMARY KEY (run_id);


--
-- Name: agent_webhook_deliveries agent_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_webhook_deliveries
    ADD CONSTRAINT agent_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: agents agents_app_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_app_id_name_key UNIQUE (app_id, name);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_logs ai_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: app_connected_accounts app_connected_accounts_app_id_app_user_id_toolkit_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_connected_accounts
    ADD CONSTRAINT app_connected_accounts_app_id_app_user_id_toolkit_slug_key UNIQUE (app_id, app_user_id, toolkit_slug);


--
-- Name: app_connected_accounts app_connected_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_connected_accounts
    ADD CONSTRAINT app_connected_accounts_pkey PRIMARY KEY (id);


--
-- Name: app_custom_domains app_custom_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_custom_domains
    ADD CONSTRAINT app_custom_domains_pkey PRIMARY KEY (id);


--
-- Name: app_db_connections app_db_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_db_connections
    ADD CONSTRAINT app_db_connections_pkey PRIMARY KEY (app_id);


--
-- Name: app_do_deploy_state app_do_deploy_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_do_deploy_state
    ADD CONSTRAINT app_do_deploy_state_pkey PRIMARY KEY (app_id);


--
-- Name: app_do_env_vars app_do_env_vars_app_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_do_env_vars
    ADD CONSTRAINT app_do_env_vars_app_id_key_key UNIQUE (app_id, key);


--
-- Name: app_do_env_vars app_do_env_vars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_do_env_vars
    ADD CONSTRAINT app_do_env_vars_pkey PRIMARY KEY (id);


--
-- Name: app_durable_objects app_durable_objects_app_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_durable_objects
    ADD CONSTRAINT app_durable_objects_app_id_name_key UNIQUE (app_id, name);


--
-- Name: app_durable_objects app_durable_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_durable_objects
    ADD CONSTRAINT app_durable_objects_pkey PRIMARY KEY (id);


--
-- Name: app_edge_ssr_deployments app_edge_ssr_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_edge_ssr_deployments
    ADD CONSTRAINT app_edge_ssr_deployments_pkey PRIMARY KEY (id);


--
-- Name: app_frontend_env_vars app_frontend_env_vars_app_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_frontend_env_vars
    ADD CONSTRAINT app_frontend_env_vars_app_id_key_key UNIQUE (app_id, key);


--
-- Name: app_frontend_env_vars app_frontend_env_vars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_frontend_env_vars
    ADD CONSTRAINT app_frontend_env_vars_pkey PRIMARY KEY (id);


--
-- Name: app_functions app_functions_app_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_functions
    ADD CONSTRAINT app_functions_app_id_name_key UNIQUE (app_id, name);


--
-- Name: app_functions app_functions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_functions
    ADD CONSTRAINT app_functions_pkey PRIMARY KEY (id);


--
-- Name: app_integration_configs app_integration_configs_app_id_toolkit_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_integration_configs
    ADD CONSTRAINT app_integration_configs_app_id_toolkit_slug_key UNIQUE (app_id, toolkit_slug);


--
-- Name: app_integration_configs app_integration_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_integration_configs
    ADD CONSTRAINT app_integration_configs_pkey PRIMARY KEY (id);


--
-- Name: app_oauth_configs app_oauth_configs_app_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_oauth_configs
    ADD CONSTRAINT app_oauth_configs_app_id_provider_key UNIQUE (app_id, provider);


--
-- Name: app_oauth_configs app_oauth_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_oauth_configs
    ADD CONSTRAINT app_oauth_configs_pkey PRIMARY KEY (id);


--
-- Name: app_orders app_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_orders
    ADD CONSTRAINT app_orders_pkey PRIMARY KEY (id);


--
-- Name: app_orders app_orders_stripe_checkout_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_orders
    ADD CONSTRAINT app_orders_stripe_checkout_session_id_key UNIQUE (stripe_checkout_session_id);


--
-- Name: app_plans app_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_plans
    ADD CONSTRAINT app_plans_pkey PRIMARY KEY (id);


--
-- Name: app_products app_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_products
    ADD CONSTRAINT app_products_pkey PRIMARY KEY (id);


--
-- Name: app_realtime_config app_realtime_config_app_id_table_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_realtime_config
    ADD CONSTRAINT app_realtime_config_app_id_table_name_key UNIQUE (app_id, table_name);


--
-- Name: app_realtime_config app_realtime_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_realtime_config
    ADD CONSTRAINT app_realtime_config_pkey PRIMARY KEY (id);


--
-- Name: app_refresh_tokens app_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_refresh_tokens
    ADD CONSTRAINT app_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: app_refresh_tokens app_refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_refresh_tokens
    ADD CONSTRAINT app_refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: app_signing_keys app_signing_keys_app_id_kid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_signing_keys
    ADD CONSTRAINT app_signing_keys_app_id_kid_key UNIQUE (app_id, kid);


--
-- Name: app_signing_keys app_signing_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_signing_keys
    ADD CONSTRAINT app_signing_keys_pkey PRIMARY KEY (id);


--
-- Name: app_subscriptions app_subscriptions_app_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_app_id_user_id_key UNIQUE (app_id, user_id);


--
-- Name: app_subscriptions app_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: app_subscriptions app_subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: app_users app_users_app_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_app_id_email_key UNIQUE (app_id, email);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_verification_codes app_verification_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_verification_codes
    ADD CONSTRAINT app_verification_codes_pkey PRIMARY KEY (id);


--
-- Name: apps apps_anon_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_anon_key_unique UNIQUE (anon_key);


--
-- Name: apps apps_db_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_db_name_key UNIQUE (db_name);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: apps apps_stripe_connect_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_stripe_connect_account_id_key UNIQUE (stripe_connect_account_id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: dispatcher_cursors dispatcher_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatcher_cursors
    ADD CONSTRAINT dispatcher_cursors_pkey PRIMARY KEY (name);


--
-- Name: function_invocations function_invocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_invocations
    ADD CONSTRAINT function_invocations_pkey PRIMARY KEY (id);


--
-- Name: function_triggers function_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_triggers
    ADD CONSTRAINT function_triggers_pkey PRIMARY KEY (id);


--
-- Name: mcp_tool_call_log mcp_tool_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tool_call_log
    ADD CONSTRAINT mcp_tool_call_log_pkey PRIMARY KEY (id);


--
-- Name: oauth_states oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (state);


--
-- Name: partner_keys partner_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_keys
    ADD CONSTRAINT partner_keys_pkey PRIMARY KEY (id);


--
-- Name: partner_pools partner_pools_hackathon_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_pools
    ADD CONSTRAINT partner_pools_hackathon_id_slug_key UNIQUE (hackathon_id, slug);


--
-- Name: partner_pools partner_pools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_pools
    ADD CONSTRAINT partner_pools_pkey PRIMARY KEY (id);


--
-- Name: partner_proxy_logs partner_proxy_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_proxy_logs
    ADD CONSTRAINT partner_proxy_logs_pkey PRIMARY KEY (id);


--
-- Name: storage_objects storage_objects_app_id_bucket_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_app_id_bucket_key_key UNIQUE (app_id, bucket, key);


--
-- Name: storage_objects storage_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_checkpoints_run_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_checkpoints_run_latest ON public.agent_checkpoints USING btree (run_id, step DESC);


--
-- Name: idx_agent_mcp_servers_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_mcp_servers_app ON public.agent_mcp_servers USING btree (app_id, status);


--
-- Name: idx_agent_run_events_run_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_events_run_seq ON public.agent_run_events USING btree (run_id, seq);


--
-- Name: idx_agent_runs_agent_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_agent_active ON public.agent_runs USING btree (agent_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'cancelling'::text, 'waiting_for_human'::text]));


--
-- Name: idx_agent_runs_agent_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_agent_created ON public.agent_runs USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_runs_app_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_app_status_created ON public.agent_runs USING btree (app_id, status, created_at DESC);


--
-- Name: idx_agent_runs_caller_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_caller_user ON public.agent_runs USING btree (caller_user_id, agent_id, created_at DESC) WHERE (caller_user_id IS NOT NULL);


--
-- Name: idx_agent_runs_running_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_running_heartbeat ON public.agent_runs USING btree (status, last_heartbeat) WHERE (status = ANY (ARRAY['running'::text, 'cancelling'::text]));


--
-- Name: idx_agent_tool_audits_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_audits_app ON public.agent_tool_audits USING btree (app_id, created_at DESC);


--
-- Name: idx_agent_tool_audits_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_audits_run ON public.agent_tool_audits USING btree (run_id, created_at);


--
-- Name: idx_agent_webhook_deliveries_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_webhook_deliveries_due ON public.agent_webhook_deliveries USING btree (status, next_attempt) WHERE (status = 'pending'::text);


--
-- Name: idx_agents_app_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_app_status ON public.agents USING btree (app_id, status);


--
-- Name: idx_ai_usage_logs_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_logs_app_id ON public.ai_usage_logs USING btree (app_id);


--
-- Name: idx_ai_usage_logs_billing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_logs_billing ON public.ai_usage_logs USING btree (app_id, key_type, charged_to_user, created_at);


--
-- Name: idx_ai_usage_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_logs_created_at ON public.ai_usage_logs USING btree (created_at);


--
-- Name: idx_ai_usage_logs_key_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_logs_key_type ON public.ai_usage_logs USING btree (key_type, charged_to_user);


--
-- Name: idx_app_do_env_vars_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_do_env_vars_app ON public.app_do_env_vars USING btree (app_id);


--
-- Name: idx_app_frontend_env_vars_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_frontend_env_vars_app ON public.app_frontend_env_vars USING btree (app_id);


--
-- Name: idx_app_functions_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_functions_app_id ON public.app_functions USING btree (app_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_app_functions_trigger_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_functions_trigger_type ON public.app_functions USING btree (trigger_type) WHERE (deleted_at IS NULL);


--
-- Name: idx_app_oauth_configs_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_oauth_configs_app_id ON public.app_oauth_configs USING btree (app_id);


--
-- Name: idx_app_orders_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_orders_app_id ON public.app_orders USING btree (app_id);


--
-- Name: idx_app_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_orders_status ON public.app_orders USING btree (app_id, status);


--
-- Name: idx_app_orders_stripe_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_orders_stripe_session ON public.app_orders USING btree (stripe_checkout_session_id);


--
-- Name: idx_app_orders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_orders_user_id ON public.app_orders USING btree (user_id);


--
-- Name: idx_app_plans_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_plans_active ON public.app_plans USING btree (app_id, active);


--
-- Name: idx_app_plans_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_plans_app_id ON public.app_plans USING btree (app_id);


--
-- Name: idx_app_products_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_products_active ON public.app_products USING btree (app_id, active);


--
-- Name: idx_app_products_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_products_app_id ON public.app_products USING btree (app_id);


--
-- Name: idx_app_realtime_config_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_realtime_config_app ON public.app_realtime_config USING btree (app_id) WHERE (enabled = true);


--
-- Name: idx_app_refresh_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_refresh_tokens_token_hash ON public.app_refresh_tokens USING btree (token_hash);


--
-- Name: idx_app_refresh_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_refresh_tokens_user ON public.app_refresh_tokens USING btree (app_id, user_id);


--
-- Name: idx_app_signing_keys_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_signing_keys_app_id ON public.app_signing_keys USING btree (app_id);


--
-- Name: idx_app_subscriptions_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_subscriptions_app_id ON public.app_subscriptions USING btree (app_id);


--
-- Name: idx_app_subscriptions_grace_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_subscriptions_grace_period ON public.app_subscriptions USING btree (grace_period_ends_at) WHERE ((status = 'past_due'::text) AND (grace_period_ends_at IS NOT NULL));


--
-- Name: idx_app_subscriptions_stripe_subscription_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_subscriptions_stripe_subscription_id ON public.app_subscriptions USING btree (stripe_subscription_id);


--
-- Name: idx_app_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_subscriptions_user_id ON public.app_subscriptions USING btree (user_id);


--
-- Name: idx_app_users_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_app_id ON public.app_users USING btree (app_id);


--
-- Name: idx_app_users_app_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_app_id_created_at ON public.app_users USING btree (app_id, created_at);


--
-- Name: idx_app_users_provider_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_app_users_provider_uid ON public.app_users USING btree (app_id, provider, provider_uid) WHERE (provider_uid IS NOT NULL);


--
-- Name: idx_app_verification_codes_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_verification_codes_expires ON public.app_verification_codes USING btree (expires_at);


--
-- Name: idx_app_verification_codes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_verification_codes_user ON public.app_verification_codes USING btree (app_id, user_id);


--
-- Name: idx_apps_allowed_origins; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_allowed_origins ON public.apps USING gin (allowed_origins);


--
-- Name: idx_apps_deployment_backend_wfp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_deployment_backend_wfp ON public.apps USING btree (id) WHERE (deployment_backend = 'wfp'::text);


--
-- Name: idx_apps_jwt_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_jwt_config ON public.apps USING gin (jwt_config);


--
-- Name: idx_apps_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_owner_id ON public.apps USING btree (owner_id);


--
-- Name: idx_apps_stripe_connect_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_stripe_connect_account_id ON public.apps USING btree (stripe_connect_account_id);


--
-- Name: idx_apps_subdomain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_apps_subdomain ON public.apps USING btree (subdomain) WHERE (subdomain IS NOT NULL);


--
-- Name: idx_audit_events_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_actor ON public.audit_events USING btree (actor_type, actor_id, created_at DESC);


--
-- Name: idx_audit_events_app_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_app_category ON public.audit_events USING btree (app_id, category, created_at DESC);


--
-- Name: idx_audit_events_app_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_app_created ON public.audit_events USING btree (app_id, created_at DESC);


--
-- Name: idx_audit_events_app_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_app_resource ON public.audit_events USING btree (app_id, resource_type, resource_id, created_at DESC);


--
-- Name: idx_audit_events_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_event_type ON public.audit_events USING btree (app_id, event_type, created_at DESC);


--
-- Name: idx_audit_events_storage_upload_cursor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_events_storage_upload_cursor ON public.audit_events USING btree (created_at, id) WHERE (event_type = 'storage.upload'::text);


--
-- Name: idx_connected_accounts_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connected_accounts_app ON public.app_connected_accounts USING btree (app_id);


--
-- Name: idx_connected_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connected_accounts_user ON public.app_connected_accounts USING btree (app_id, app_user_id);


--
-- Name: idx_custom_domains_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_domains_app_id ON public.app_custom_domains USING btree (app_id);


--
-- Name: idx_custom_domains_cf_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_domains_cf_id ON public.app_custom_domains USING btree (cf_custom_hostname_id) WHERE (cf_custom_hostname_id IS NOT NULL);


--
-- Name: idx_custom_domains_hostname; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_custom_domains_hostname ON public.app_custom_domains USING btree (hostname);


--
-- Name: idx_durable_objects_app_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_durable_objects_app_status ON public.app_durable_objects USING btree (app_id, status);


--
-- Name: idx_edge_ssr_deployments_app_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_ssr_deployments_app_created ON public.app_edge_ssr_deployments USING btree (app_id, created_at DESC);


--
-- Name: idx_edge_ssr_deployments_app_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_ssr_deployments_app_status_created ON public.app_edge_ssr_deployments USING btree (app_id, status, created_at DESC);


--
-- Name: idx_function_invocations_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_invocations_app ON public.function_invocations USING btree (app_id, started_at DESC);


--
-- Name: idx_function_invocations_billing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_invocations_billing ON public.function_invocations USING btree (app_id, started_at) WHERE (completed_at IS NOT NULL);


--
-- Name: idx_function_invocations_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_function_invocations_dedupe ON public.function_invocations USING btree (function_id, source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: idx_function_invocations_function; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_invocations_function ON public.function_invocations USING btree (function_id, started_at DESC);


--
-- Name: idx_function_invocations_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_invocations_retry ON public.function_invocations USING btree (next_retry_at) WHERE ((status)::text = 'failed_retrying'::text);


--
-- Name: idx_function_triggers_function; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_triggers_function ON public.function_triggers USING btree (function_id);


--
-- Name: idx_function_triggers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_function_triggers_type ON public.function_triggers USING btree (trigger_type, app_id) WHERE (enabled = true);


--
-- Name: idx_function_triggers_unique_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_function_triggers_unique_type ON public.function_triggers USING btree (function_id, trigger_type);


--
-- Name: idx_integration_configs_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_configs_app ON public.app_integration_configs USING btree (app_id);


--
-- Name: idx_mcp_tool_call_log_api_key_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_tool_call_log_api_key_time ON public.mcp_tool_call_log USING btree (api_key_id, created_at DESC);


--
-- Name: idx_mcp_tool_call_log_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_tool_call_log_user_time ON public.mcp_tool_call_log USING btree (user_id, created_at DESC);


--
-- Name: idx_oauth_states_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_states_expires_at ON public.oauth_states USING btree (expires_at);


--
-- Name: idx_partner_keys_pool_active_lru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_keys_pool_active_lru ON public.partner_keys USING btree (pool_id, last_used_at NULLS FIRST) WHERE (status = 'active'::text);


--
-- Name: idx_partner_keys_pool_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_keys_pool_status ON public.partner_keys USING btree (pool_id, status);


--
-- Name: idx_partner_pools_hackathon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_pools_hackathon ON public.partner_pools USING btree (hackathon_id);


--
-- Name: idx_ppl_pool_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ppl_pool_created ON public.partner_proxy_logs USING btree (pool_id, created_at DESC);


--
-- Name: idx_ppl_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ppl_user_created ON public.partner_proxy_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_storage_objects_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_objects_app_id ON public.storage_objects USING btree (app_id);


--
-- Name: idx_storage_objects_app_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_objects_app_id_created_at ON public.storage_objects USING btree (app_id, created_at);


--
-- Name: idx_storage_objects_app_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_objects_app_public ON public.storage_objects USING btree (app_id, public) WHERE (public = true);


--
-- Name: idx_storage_objects_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_objects_user_id ON public.storage_objects USING btree (user_id);


--
-- Name: partner_pools trg_partner_pools_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_partner_pools_updated_at BEFORE UPDATE ON public.partner_pools FOR EACH ROW EXECUTE FUNCTION public.partner_pools_set_updated_at();


--
-- Name: agent_checkpoints agent_checkpoints_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_checkpoints
    ADD CONSTRAINT agent_checkpoints_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_mcp_servers agent_mcp_servers_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: agent_run_events agent_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: agent_tool_audits agent_tool_audits_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audits
    ADD CONSTRAINT agent_tool_audits_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: agent_tool_audits agent_tool_audits_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audits
    ADD CONSTRAINT agent_tool_audits_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_tool_audits agent_tool_audits_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audits
    ADD CONSTRAINT agent_tool_audits_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.agent_mcp_servers(id) ON DELETE SET NULL;


--
-- Name: agent_usage agent_usage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_webhook_deliveries agent_webhook_deliveries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_webhook_deliveries
    ADD CONSTRAINT agent_webhook_deliveries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agents agents_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: ai_usage_logs ai_usage_logs_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_connected_accounts app_connected_accounts_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_connected_accounts
    ADD CONSTRAINT app_connected_accounts_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_custom_domains app_custom_domains_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_custom_domains
    ADD CONSTRAINT app_custom_domains_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_db_connections app_db_connections_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_db_connections
    ADD CONSTRAINT app_db_connections_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_do_deploy_state app_do_deploy_state_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_do_deploy_state
    ADD CONSTRAINT app_do_deploy_state_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_do_env_vars app_do_env_vars_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_do_env_vars
    ADD CONSTRAINT app_do_env_vars_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_durable_objects app_durable_objects_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_durable_objects
    ADD CONSTRAINT app_durable_objects_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_edge_ssr_deployments app_edge_ssr_deployments_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_edge_ssr_deployments
    ADD CONSTRAINT app_edge_ssr_deployments_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_frontend_env_vars app_frontend_env_vars_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_frontend_env_vars
    ADD CONSTRAINT app_frontend_env_vars_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_functions app_functions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_functions
    ADD CONSTRAINT app_functions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_integration_configs app_integration_configs_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_integration_configs
    ADD CONSTRAINT app_integration_configs_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_oauth_configs app_oauth_configs_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_oauth_configs
    ADD CONSTRAINT app_oauth_configs_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_orders app_orders_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_orders
    ADD CONSTRAINT app_orders_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_orders app_orders_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_orders
    ADD CONSTRAINT app_orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.app_products(id) ON DELETE CASCADE;


--
-- Name: app_orders app_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_orders
    ADD CONSTRAINT app_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: app_plans app_plans_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_plans
    ADD CONSTRAINT app_plans_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_products app_products_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_products
    ADD CONSTRAINT app_products_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_realtime_config app_realtime_config_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_realtime_config
    ADD CONSTRAINT app_realtime_config_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_refresh_tokens app_refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_refresh_tokens
    ADD CONSTRAINT app_refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: app_signing_keys app_signing_keys_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_signing_keys
    ADD CONSTRAINT app_signing_keys_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_subscriptions app_subscriptions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_subscriptions app_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.app_plans(id) ON DELETE CASCADE;


--
-- Name: app_subscriptions app_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_subscriptions
    ADD CONSTRAINT app_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: app_users app_users_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_verification_codes app_verification_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_verification_codes
    ADD CONSTRAINT app_verification_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: function_invocations function_invocations_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_invocations
    ADD CONSTRAINT function_invocations_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: function_invocations function_invocations_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_invocations
    ADD CONSTRAINT function_invocations_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.app_functions(id) ON DELETE CASCADE;


--
-- Name: function_triggers function_triggers_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_triggers
    ADD CONSTRAINT function_triggers_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: function_triggers function_triggers_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.function_triggers
    ADD CONSTRAINT function_triggers_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.app_functions(id) ON DELETE CASCADE;


--
-- Name: partner_keys partner_keys_pool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_keys
    ADD CONSTRAINT partner_keys_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.partner_pools(id) ON DELETE CASCADE;


--
-- Name: partner_proxy_logs partner_proxy_logs_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_proxy_logs
    ADD CONSTRAINT partner_proxy_logs_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.partner_keys(id) ON DELETE SET NULL;


--
-- Name: partner_proxy_logs partner_proxy_logs_pool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_proxy_logs
    ADD CONSTRAINT partner_proxy_logs_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.partner_pools(id) ON DELETE CASCADE;


--
-- Name: storage_objects storage_objects_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: storage_objects storage_objects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;
