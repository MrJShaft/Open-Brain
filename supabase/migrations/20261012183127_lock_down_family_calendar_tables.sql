-- DRAFT (not applied). Lock down family-calendar tables that were created without RLS.
-- family-calendar-mcp uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS and is
-- unaffected by grants to anon/authenticated, so the MCP keeps working.
-- Effect: the public anon key / signed-in users can no longer read or write these tables
-- via PostgREST. No policies are created on purpose (deny-all for non-service roles).
BEGIN;
ALTER TABLE public.family_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.important_dates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.family_members  FROM anon, authenticated;
REVOKE ALL ON TABLE public.activities      FROM anon, authenticated;
REVOKE ALL ON TABLE public.important_dates FROM anon, authenticated;
COMMIT;

-- Rollback:
-- ALTER TABLE public.family_members  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.activities      DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.important_dates DISABLE ROW LEVEL SECURITY;
-- GRANT ALL ON TABLE public.family_members, public.activities, public.important_dates TO anon, authenticated;
