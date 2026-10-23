-- OB1 Wellness Log (Honey only)
-- Personal health data (energy/hunger/alertness/food). Never shared with other
-- agents, never mixed into agent_memories/shared_agent_memories/thoughts, and
-- accessed only through agent-memory-api's Honey-gated /wellness routes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_wellness_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner TEXT NOT NULL,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('check_in', 'food', 'missed')),
  energy SMALLINT CHECK (energy BETWEEN 1 AND 5),
  hunger SMALLINT CHECK (hunger BETWEEN 1 AND 5),
  alertness SMALLINT CHECK (alertness BETWEEN 1 AND 5),
  food_text TEXT,
  food_size TEXT CHECK (food_size IN ('small', 'medium', 'large')),
  caffeine BOOLEAN,
  alcohol BOOLEAN,
  note TEXT,
  source TEXT CHECK (source IN ('prompted', 'unprompted')),
  tunnel_progress TEXT CHECK (tunnel_progress IN ('yes', 'a bit', 'no')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_wellness_log_owner_logged_at_idx
  ON public.agent_wellness_log (owner, logged_at);

ALTER TABLE public.agent_wellness_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_wellness_log_service_role_all ON public.agent_wellness_log;
CREATE POLICY agent_wellness_log_service_role_all
  ON public.agent_wellness_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.agent_wellness_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_wellness_log TO service_role;

COMMENT ON TABLE public.agent_wellness_log IS
  'Personal health log (energy/hunger/alertness/food check-ins). Honey-only: accessed exclusively through agent-memory-api''s Honey-gated /wellness routes, never surfaced via agent_memory_audit_events, thoughts, or shared memories.';

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS public.agent_wellness_log;
