-- DRAFT (Tyrone review). Run AFTER schema.sql, api-credentials.sql, shared-memories.sql.
-- 1) Agent memories get their own embeddings so write-back no longer touches public.thoughts.
-- 2) Owner-scoped vector match RPC (service_role only).
-- 3) Advisory work locks with TTL.
-- 4) Explicit deny for anon/authenticated on all agent-memory tables (defense in depth).
BEGIN;

ALTER TABLE public.agent_memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_agent_memories_embedding
  ON public.agent_memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_agent_memories_owner
  ON public.agent_memories (workspace_id, (metadata->>'authenticated_agent_id'));

CREATE OR REPLACE FUNCTION public.match_agent_memories(
  query_embedding vector(1536),
  p_workspace_id TEXT,
  p_agent_id TEXT,
  match_threshold DOUBLE PRECISION DEFAULT 0.25,
  match_count INTEGER DEFAULT 40
) RETURNS TABLE (id UUID, similarity DOUBLE PRECISION)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions AS $$
  SELECT m.id, 1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.agent_memories m
  WHERE m.workspace_id = p_workspace_id
    AND m.metadata->>'authenticated_agent_id' = p_agent_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT least(greatest(match_count, 1), 200);
$$;
REVOKE ALL ON FUNCTION public.match_agent_memories(vector, TEXT, TEXT, DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_agent_memories(vector, TEXT, TEXT, DOUBLE PRECISION, INTEGER) TO service_role;

CREATE TABLE IF NOT EXISTS public.agent_memory_locks (
  workspace_id TEXT NOT NULL,
  lock_key TEXT NOT NULL CHECK (length(lock_key) BETWEEN 1 AND 200),
  holder_agent_id TEXT NOT NULL,
  note TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, lock_key)
);
ALTER TABLE public.agent_memory_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memory_locks_service_role_all ON public.agent_memory_locks;
CREATE POLICY agent_memory_locks_service_role_all ON public.agent_memory_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Atomic acquire: succeeds if free, expired, or already held by the same agent (renews).
CREATE OR REPLACE FUNCTION public.agent_memory_acquire_lock(
  p_workspace_id TEXT, p_lock_key TEXT, p_agent_id TEXT, p_ttl_seconds INTEGER, p_note TEXT DEFAULT NULL
) RETURNS public.agent_memory_locks
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public AS $$
  INSERT INTO public.agent_memory_locks AS l (workspace_id, lock_key, holder_agent_id, note, expires_at)
  VALUES (p_workspace_id, p_lock_key, p_agent_id, p_note,
          now() + make_interval(secs => least(greatest(p_ttl_seconds, 10), 86400)))
  ON CONFLICT (workspace_id, lock_key) DO UPDATE
    SET holder_agent_id = EXCLUDED.holder_agent_id, note = EXCLUDED.note,
        acquired_at = now(), expires_at = EXCLUDED.expires_at
    WHERE l.expires_at < now() OR l.holder_agent_id = EXCLUDED.holder_agent_id
  RETURNING l.*;
$$;
REVOKE ALL ON FUNCTION public.agent_memory_acquire_lock(TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_memory_acquire_lock(TEXT, TEXT, TEXT, INTEGER, TEXT) TO service_role;

REVOKE ALL ON TABLE
  public.agent_memories, public.agent_memory_source_refs, public.agent_memory_artifacts,
  public.agent_memory_relations, public.agent_memory_review_actions, public.agent_memory_recall_traces,
  public.agent_memory_recall_items, public.agent_memory_audit_events, public.agent_memory_locks,
  public.shared_agent_memories, public.agent_api_credentials
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_memory_locks TO service_role;
REVOKE ALL ON FUNCTION public.agent_memory_hash_text(TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Rollback:
-- DROP FUNCTION IF EXISTS public.agent_memory_acquire_lock(TEXT, TEXT, TEXT, INTEGER, TEXT);
-- DROP TABLE IF EXISTS public.agent_memory_locks;
-- DROP FUNCTION IF EXISTS public.match_agent_memories(vector, TEXT, TEXT, DOUBLE PRECISION, INTEGER);
-- DROP INDEX IF EXISTS public.idx_agent_memories_embedding, public.idx_agent_memories_owner;
-- ALTER TABLE public.agent_memories DROP COLUMN IF EXISTS embedding;
