-- @scope: runtime
-- Add usage_meters to runtime tier. Same regression class as migration
-- 007: usage_meters is treated as runtime-tier in usage-metering.ts but
-- was never added to db/runtime-plane/001_initial_runtime_schema.sql,
-- so every quota check and usage flush errors 'relation does not exist'.
-- The cross-tier FK to platform_users is intentionally dropped (same
-- pattern as the deployed_by FK in 007).

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
-- Name: usage_meters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_meters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    app_id text,
    meter_type text NOT NULL,
    period_start date NOT NULL,
    quantity bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_meters usage_meters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_meters
    ADD CONSTRAINT usage_meters_pkey PRIMARY KEY (id);


--
-- Name: usage_meters usage_meters_user_id_app_id_meter_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_meters
    ADD CONSTRAINT usage_meters_user_id_app_id_meter_type_period_start_key UNIQUE (user_id, app_id, meter_type, period_start);


--
-- Name: idx_usage_meters_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_meters_app ON public.usage_meters USING btree (app_id, meter_type, period_start);


--
-- Name: idx_usage_meters_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_meters_lookup ON public.usage_meters USING btree (user_id, meter_type, period_start);


--
-- Name: usage_meters usage_meters_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_meters
    ADD CONSTRAINT usage_meters_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;



--
-- PostgreSQL database dump complete
--


