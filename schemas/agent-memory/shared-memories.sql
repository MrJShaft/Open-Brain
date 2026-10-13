-- OB1 Shared Agent Memories
-- Project/workspace/organization-scoped records for explicitly shared context.
-- This definition matches the deployed table contract; agent-memory-api accesses
-- it only through the Supabase service role after per-Agent bearer auth.

BEGIN;

CREATE TABLE IF NOT EXISTS public.shared_agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  sharing_scope TEXT NOT NULL DEFAULT 'project' CHECK (
    sharing_scope IN ('project', 'workspace', 'organization')
  ),
  memory_type TEXT NOT NULL CHECK (
    memory_type IN (
      'decision',
      'output',
      'lesson',
      'constraint',
      'open_question',
      'failure',
      'artifact_reference',
      'work_log'
    )
  ),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by_agent TEXT NOT NULL DEFAULT 'cue',
  provenance_status TEXT NOT NULL DEFAULT 'generated' CHECK (
    provenance_status IN ('observed', 'inferred', 'user_confirmed', 'imported', 'generated')
  ),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50 CHECK (
    confidence >= 0 AND confidence <= 1
  ),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'stale', 'superseded', 'disputed', 'rejected')
  ),
  can_use_as_instruction BOOLEAN NOT NULL DEFAULT false,
  can_use_as_evidence BOOLEAN NOT NULL DEFAULT true,
  requires_user_confirmation BOOLEAN NOT NULL DEFAULT true,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'confirmed', 'evidence_only', 'restricted', 'rejected', 'stale', 'merged')
  ),
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sharing_scope <> 'project' OR project_id IS NOT NULL),
  CHECK (
    can_use_as_instruction = false
    OR provenance_status IN ('user_confirmed', 'imported')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_agent_memories_idempotency_key
  ON public.shared_agent_memories (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shared_agent_memories_scope
  ON public.shared_agent_memories (workspace_id, sharing_scope, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_agent_memories_status
  ON public.shared_agent_memories (review_status, lifecycle_status, created_at DESC);

ALTER TABLE public.shared_agent_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shared_agent_memories_service_role_all ON public.shared_agent_memories;
CREATE POLICY shared_agent_memories_service_role_all
  ON public.shared_agent_memories
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.shared_agent_memories FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shared_agent_memories TO service_role;

COMMIT;
