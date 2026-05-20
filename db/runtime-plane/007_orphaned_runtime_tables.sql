-- @scope: runtime
-- Add orphaned runtime tables missed in Phase 2 cutover: app_deployments,
-- neon_tasks, rag_ingestion_queue. All three have FK→apps(id) and were
-- being written from control-api to platform DB (FK violation since apps
-- now lives in runtime). Schema dumped from platform-tier verbatim; the
-- app_deployments.deployed_by FK to platform_users is intentionally
-- omitted (cross-tier — same pattern as migration 060).

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.8 (ad62774)
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    framework character varying(50),
    deployment_url text,
    cloudflare_project_name text,
    cloudflare_deployment_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    build_config jsonb DEFAULT '{}'::jsonb,
    file_count integer,
    total_size_bytes bigint,
    deployed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    r2_object_key text,
    upload_expires_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    env_vars_stale boolean DEFAULT false NOT NULL
);


--
-- Name: neon_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neon_tasks (
    id bigint NOT NULL,
    app_id text NOT NULL,
    task_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    last_error text,
    locked_at timestamp with time zone,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT neon_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT neon_tasks_task_type_check CHECK ((task_type = ANY (ARRAY['provision'::text, 'deprovision'::text])))
);


--
-- Name: neon_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neon_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neon_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neon_tasks_id_seq OWNED BY public.neon_tasks.id;


--
-- Name: rag_ingestion_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rag_ingestion_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id text NOT NULL,
    document_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    error_message text,
    locked_at timestamp with time zone,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rag_ingestion_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: neon_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neon_tasks ALTER COLUMN id SET DEFAULT nextval('public.neon_tasks_id_seq'::regclass);


--
-- Name: app_deployments app_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_deployments
    ADD CONSTRAINT app_deployments_pkey PRIMARY KEY (id);


--
-- Name: neon_tasks neon_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neon_tasks
    ADD CONSTRAINT neon_tasks_pkey PRIMARY KEY (id);


--
-- Name: rag_ingestion_queue rag_ingestion_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_ingestion_queue
    ADD CONSTRAINT rag_ingestion_queue_pkey PRIMARY KEY (id);


--
-- Name: idx_app_deployments_app_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_deployments_app_id ON public.app_deployments USING btree (app_id);


--
-- Name: idx_app_deployments_cloudflare_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_deployments_cloudflare_id ON public.app_deployments USING btree (cloudflare_deployment_id) WHERE (cloudflare_deployment_id IS NOT NULL);


--
-- Name: idx_app_deployments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_deployments_status ON public.app_deployments USING btree (status);


--
-- Name: idx_neon_tasks_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_neon_tasks_active_unique ON public.neon_tasks USING btree (app_id, task_type) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: idx_neon_tasks_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_neon_tasks_pending ON public.neon_tasks USING btree (run_after) WHERE (status = 'pending'::text);


--
-- Name: idx_rag_queue_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rag_queue_app ON public.rag_ingestion_queue USING btree (app_id);


--
-- Name: idx_rag_queue_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rag_queue_pending ON public.rag_ingestion_queue USING btree (status, run_after) WHERE (status = 'pending'::text);


--
-- Name: app_deployments app_deployments_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_deployments
    ADD CONSTRAINT app_deployments_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;



--
-- Name: neon_tasks neon_tasks_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neon_tasks
    ADD CONSTRAINT neon_tasks_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: rag_ingestion_queue rag_ingestion_queue_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_ingestion_queue
    ADD CONSTRAINT rag_ingestion_queue_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

