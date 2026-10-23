# Agent Memory MCP connector

Remote MCP (Streamable HTTP) front end for [`agent-memory-api`](../agent-memory-api/).
It holds no database credentials: every tool call is forwarded to `agent-memory-api`
with the caller's own per-Agent token, so authentication, ownership isolation,
capabilities, and per-key usage logging are enforced in one place.

## Auth

Each Agent has its own token (`agent_api_credentials`, hash only). Send it as any of:

- `x-brain-key: <token>` header
- `Authorization: Bearer <token>` header

Query-string keys (`?key=<token>`) are no longer accepted; gateway/request logs can
record query strings, so send the token in a header instead.

## Tools

`recall_memories`, `write_memory`, `list_memories`, `get_memory`, `supersede_memory`,
`forget_memory`, `list_review_queue`, `review_memory`, `report_memory_usage`,
`inspect_recall_trace`, `acquire_lock`, `release_lock`, `list_shared_memories`,
`write_shared_memory`, and `approve_shared_memory` (listed only for keys with the
`shared:approve` capability).

Recall only ever searches the calling Agent's own memories, and includes its personal
and pending (unreviewed) memories by default. `list_review_queue` and `review_memory`
let an Agent see and act (`reject` / `mark_stale` / `dispute`) on its own pending
memories; only the user can approve or confirm a memory. `report_memory_usage` and
`inspect_recall_trace` operate on the `request_id` returned by `recall_memories`.

See [`AGENT_GUIDANCE.md`](./AGENT_GUIDANCE.md) for the full workflow and trust rules
these tools are meant to be used under.

## Wellness log (Honey only)

`log_wellness`, `list_wellness`, `wellness_summary`, `update_wellness`, and
`delete_wellness` are registered only when the authenticated Agent ID is `honey`;
no other Agent sees these tools. They track private health data (energy, hunger,
alertness, food) and are never copied into shared memory, `thoughts`, or OneDrive.
`update_wellness` and `delete_wellness` require `confirm: true` and should only be
used when Tyrone explicitly asks for an edit or deletion. The backing table is
defined in [`schemas/agent-memory/wellness-log.sql`](../../schemas/agent-memory/wellness-log.sql).

## Deploy

```bash
supabase functions deploy agent-memory-api --no-verify-jwt
supabase functions deploy agent-memory-mcp --no-verify-jwt
```

`AGENT_MEMORY_API_URL` optionally overrides the API base (default
`$SUPABASE_URL/functions/v1/agent-memory-api`).

## Client URL

```
https://<project-ref>.supabase.co/functions/v1/agent-memory-mcp
```
