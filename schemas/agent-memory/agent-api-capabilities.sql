-- OB1 Agent Memory: per-key capabilities + per-key usage log.
-- Run after api-credentials.sql and agent-memory-hardening.sql.
-- Capabilities are opt-in; the default is none. Known values (enforced in auth.js too):
--   'shared:approve'  approve shared memories; write organization-scoped shared memories
--   'thoughts:read'   (future) read the owner's public.thoughts via /thoughts/search
BEGIN;

ALTER TABLE public.agent_api_credentials
  ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.agent_api_credentials
  DROP CONSTRAINT IF EXISTS agent_api_credentials_capabilities_known;
ALTER TABLE public.agent_api_credentials
  ADD CONSTRAINT agent_api_credentials_capabilities_known
  CHECK (capabilities <@ ARRAY['shared:approve', 'thoughts:read']::TEXT[]);

CREATE TABLE IF NOT EXISTS public.agent_api_key_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  status INTEGER,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_usage_agent_ts
  ON public.agent_api_key_usage (agent_id, ts DESC);

ALTER TABLE public.agent_api_key_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_api_key_usage_service_role_all ON public.agent_api_key_usage;
CREATE POLICY agent_api_key_usage_service_role_all ON public.agent_api_key_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.agent_api_key_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_api_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.agent_api_key_usage TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS public.agent_api_key_usage;
-- ALTER TABLE public.agent_api_credentials DROP CONSTRAINT IF EXISTS agent_api_credentials_capabilities_known;
-- ALTER TABLE public.agent_api_credentials DROP COLUMN IF EXISTS capabilities;
