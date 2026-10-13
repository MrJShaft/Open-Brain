# Agent Memory MCP connector

Remote MCP (Streamable HTTP) front end for [`agent-memory-api`](../agent-memory-api/).
It holds no database credentials: every tool call is forwarded to `agent-memory-api`
with the caller's own per-Agent token, so authentication, ownership isolation,
capabilities, and per-key usage logging are enforced in one place.

## Auth

Each Agent has its own token (`agent_api_credentials`, hash only). Send it as any of:

- `x-brain-key: <token>` header
- `Authorization: Bearer <token>` header
- `?key=<token>` query parameter (for clients that only accept a URL, e.g. Claude Desktop / ChatGPT connectors)

Prefer a header: query strings can be recorded in gateway/request logs.

## Tools

`recall_memories`, `write_memory`, `list_memories`, `get_memory`, `supersede_memory`,
`forget_memory`, `acquire_lock`, `release_lock`, `list_shared_memories`,
`write_shared_memory`, and `approve_shared_memory` (listed only for keys with the
`shared:approve` capability).

Recall only ever searches the calling Agent's own memories, and includes its personal
and pending (unreviewed) memories by default.

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
