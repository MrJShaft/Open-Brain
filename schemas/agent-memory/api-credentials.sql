-- OB1 Agent Memory API credential registry.
-- Stores only high-entropy token hashes and server-authorized workspace IDs.
-- The Edge Function uses its existing service-role client for read-only lookups.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_api_credentials (
  agent_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  workspace_ids TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(agent_id)) BETWEEN 1 AND 256),
  CHECK (agent_id !~ '[[:cntrl:]]'),
  CHECK (cardinality(workspace_ids) BETWEEN 1 AND 100),
  CHECK (array_position(workspace_ids, NULL::text) IS NULL),
  CHECK (array_position(workspace_ids, ''::text) IS NULL)
);

ALTER TABLE public.agent_api_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_api_credentials_service_role_select ON public.agent_api_credentials;
CREATE POLICY agent_api_credentials_service_role_select ON public.agent_api_credentials
  FOR SELECT TO service_role USING (true);

REVOKE ALL ON TABLE public.agent_api_credentials FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.agent_api_credentials TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
