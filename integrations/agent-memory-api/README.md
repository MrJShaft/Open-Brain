# Agent Memory API

> Runtime-neutral recall, write-back, review, inspection, shared-memory, and trace API for OB1 Agent Memory.

```mermaid
sequenceDiagram
  participant Runtime as Agent runtime
  participant API as Agent Memory API
  participant OB1 as OB1 database
  participant Human as Human reviewer
  Runtime->>API: Authorization: Bearer <Agent token>
  Runtime->>API: POST /recall
  API->>OB1: semantic search + policy ranking
  API-->>Runtime: scoped memories + use policy
  Runtime->>API: POST /writeback or /shared-memories
  API->>API: block secrets/transcripts/reasoning dumps
  API->>OB1: store pending, evidence-only memory
  Human->>API: PATCH /memories/:id/review
  API->>OB1: apply permitted review action
```

## What It Does

This Edge Function exposes the v1 OB1 Agent Memory contract. OpenClaw is the first launch runtime, but the API is runtime-neutral and can be used by Codex, Claude Code, local agents, n8n, or future adapters. It accesses memory-domain tables only; direct `anon` and `authenticated` table grants remain revoked.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- [`schemas/agent-memory`](../../schemas/agent-memory/) applied, including `api-credentials.sql`
- Supabase CLI installed for manual deployment
- `OPENROUTER_API_KEY` configured as a Supabase function secret for embedding-based recall/write-back
- A unique cryptographically random bearer token per Agent; store the raw token only in that Agent's connector and store only its SHA-256 digest in `agent_api_credentials`

## Authentication and Trust Boundaries

Every endpoint, including `/health`, requires `Authorization: Bearer <agent-token>`. The API hashes the presented token and looks up the digest in `public.agent_api_credentials` using its existing Supabase service-role client. The registry maps each digest to exactly one immutable Agent ID plus an explicit workspace allowlist; the registry grants only `SELECT` to `service_role` and no access to `anon` or `authenticated`. No additional custom Edge Function secret is required for Agent credentials. Request bodies and other headers cannot choose either identity or workspace authorization. Personal `agent_memories` are additionally filtered by the server-stamped `metadata.authenticated_agent_id`, while trace access is filtered by the authenticated Agent recorded in `request_payload`. Tokens are never accepted in query parameters or via the legacy `x-brain-key` header. Use a unique token for each Agent and never reuse the shared `MCP_ACCESS_KEY`.

Generate a fresh 32-byte URL-safe token and its SHA-256 digest in a trusted environment. Store the raw token only in that Agent's secret-backed connector/runtime setting, and store only the digest plus that Agent's explicit allowed workspaces in `public.agent_api_credentials`. Do not commit either value. Example generation prints only the digest while keeping the raw token in the shell variable for the connector setup:

```bash
TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}'
```

Provision the digest and allowlist as a database-owner action (never store the raw token in the database):

```sql
INSERT INTO public.agent_api_credentials (agent_id, token_sha256, workspace_ids)
VALUES ('<immutable-agent-id>', '<64-character-sha256-hex-digest>', ARRAY['<authorized-workspace-id>'])
ON CONFLICT (agent_id) DO UPDATE
SET token_sha256 = EXCLUDED.token_sha256,
    workspace_ids = EXCLUDED.workspace_ids,
    enabled = true;
```

Personal records or traces without a matching authenticated-Agent attribution are intentionally invisible through these routes; legacy rows are not automatically assigned to an Agent. Backfill ownership only after verifying it from a trusted source.

Agent write-backs and shared-memory writes remain pending and require user review. Caller-supplied `imported` or `user_confirmed` provenance cannot elevate an Agent write. Agent credentials cannot confirm, edit, promote to evidence-only, or widen memory scope; they may only reject, mark stale, or dispute their own records. The API assigns the authenticated Agent ID to new records and review actions server-side.

## Credential Tracker

```text
AGENT MEMORY API -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Supabase Project ref:       ____________
  Immutable Agent ID:         ____________
  Authorized workspace ID(s): ____________
  Per-Agent bearer token:     ____________

GENERATED DURING SETUP
  Agent Memory API URL:       ____________
  Token SHA-256 digest:       ____________

--------------------------------------
```

## Deployment

Apply [`schemas/agent-memory/schema.sql`](../../schemas/agent-memory/schema.sql), [`schemas/agent-memory/shared-memories.sql`](../../schemas/agent-memory/shared-memories.sql), and [`schemas/agent-memory/api-credentials.sql`](../../schemas/agent-memory/api-credentials.sql). Securely provision the Agent's credential row before deployment. Supabase Edge Functions provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically; configure only the existing `OPENROUTER_API_KEY` for embedding-based recall/write-back.

Copy this folder into your Supabase project and deploy with custom authentication enabled in the function body:

```bash
supabase functions new agent-memory-api
cp integrations/agent-memory-api/index.ts supabase/functions/agent-memory-api/index.ts
cp integrations/agent-memory-api/auth.js supabase/functions/agent-memory-api/auth.js
cp integrations/agent-memory-api/deno.json supabase/functions/agent-memory-api/deno.json
supabase functions deploy agent-memory-api --no-verify-jwt
```

`--no-verify-jwt` is intentional because the function enforces per-Agent bearer-token authentication itself. Do not deploy until an enabled per-Agent hash/workspace row exists in `agent_api_credentials` and that Agent's raw token is securely stored in its connector/runtime setting.

Verify the deployment without putting the token in the URL:

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-memory-api/health" \
  -H "Authorization: Bearer $OB1_AGENT_MEMORY_KEY"
```

The response includes `"ok": true`. Missing or invalid credentials receive `401`.

## API Surface

The API accepts the runtime-neutral core schema versions and the OpenClaw launch aliases:

| Contract | Runtime-Neutral | OpenClaw Alias |
| -------- | --------------- | -------------- |
| Recall request | `openbrain.agent_memory.recall.v1` | `openbrain.openclaw.recall.v1` |
| Recall response | `openbrain.agent_memory.recall_response.v1` | `openbrain.openclaw.recall_response.v1` |
| Write-back request | `openbrain.agent_memory.writeback.v1` | `openbrain.openclaw.writeback.v1` |
| Write-back response | `openbrain.agent_memory.writeback_response.v1` | `openbrain.openclaw.writeback_response.v1` |

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Verify authenticated deployment |
| `/recall` | POST | Retrieve only this Agent's memories from one of its allowed workspaces |
| `/writeback` | POST | Save compact operational memory after work finishes |
| `/recall/:request_id/usage` | POST | Report usage only for owned memories in this Agent's own trace |
| `/memories` | GET | List only this Agent's memories in an allowed workspace, with optional project/status/runtime/type/task filters |
| `/memories/review` | GET | List only this Agent's pending memories in an allowed workspace |
| `/memories/:id` | GET | Inspect only this Agent's record and its source/artifact details |
| `/memories/:id/review` | PATCH | Let an Agent reject, mark stale, or dispute its own writes; other review actions require a user |
| `/recall-traces/:request_id` | GET | Inspect only this Agent's trace and owned memory items |
| `/shared-memories` | GET, POST | Read or write intentionally shared memories, limited to this Agent's allowed workspaces |

`GET /shared-memories` requires `workspace_id`. Project-scoped reads also require `project_id`; workspace and organization reads omit it. Results include active confirmed/evidence-only memories by default. Use `include_unconfirmed=true` to include pending entries for review. `POST /shared-memories` accepts a memory type, summary, content, and sharing scope; project scope requires `project_id`. The server sets `created_by_agent`, keeps new entries pending, and never makes Agent-written entries instruction-grade.

## Wellness log (Honey only)

`/wellness` routes store private health check-ins (energy, hunger, alertness, food) for exactly one Agent ID, `honey`. Every other Agent credential gets `403 wellness tools are restricted to Honey`. Rows are never written to `agent_memory_audit_events`, `thoughts`, or `shared_agent_memories`, and are never logged to the console. Every query and write is scoped to `owner = <authenticated agent_id>`; the owner is always server-stamped, never taken from the request body. The table is defined in [`schemas/agent-memory/wellness-log.sql`](../../schemas/agent-memory/wellness-log.sql).

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/wellness` | POST | Record a check-in, food entry, or missed check-in |
| `/wellness` | GET | List entries in a date range (`from`/`to` as `YYYY-MM-DD`, America/Toronto; `kind`; `limit`, default 500, max 2000) |
| `/wellness/summary` | GET | By-hour and by-weekday averages, low-energy/low-alertness points with time since last food, best/worst 2-hour windows, missed-check-in count, and tunnel-progress counts over a date range |
| `/wellness/:id` | PATCH | Edit an entry; requires `confirm: true` in the body |
| `/wellness/:id` | DELETE | Delete an entry; requires `confirm=true` as a query parameter |

`from`/`to` default to the last 14 days through today (America/Toronto) and the range is capped at 366 days. `kind` is one of `check_in`, `food`, or `missed`; `check_in` requires at least one of `energy`/`hunger`/`alertness` or `tunnel_progress`, `food` requires `food_text`, and `missed` carries no scores or food fields. `food_size`/`caffeine`/`alcohol` are only valid on `food` entries.

## Expected Outcome

An authenticated Agent can recall relevant context, write back compact memories, and leave a trace that explains what happened. Unsafe write-backs are blocked before durable storage; shared memories are explicitly scoped and remain pending until reviewed.

The trust model is documented in [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md).

## Smoke Harness

Use the live smoke harness after deploying the Edge Function and configuring the per-Agent credential registry row. Its denied-workspace test uses `OB1_AGENT_MEMORY_DENIED_WORKSPACE_ID` or a derived workspace ID that must not be in the Agent's allowlist:

```bash
OB1_AGENT_MEMORY_ENDPOINT="https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-memory-api" \
OB1_AGENT_MEMORY_KEY="YOUR_PER_AGENT_BEARER_TOKEN" \
OB1_AGENT_MEMORY_WORKSPACE_ID="ob1-staging" \
OB1_AGENT_MEMORY_PROJECT_ID="agent-memory-api-smoke" \
OB1_AGENT_MEMORY_DENIED_WORKSPACE_ID="ob1-not-authorized" \
node integrations/agent-memory-api/smoke/live-smoke.mjs
```

The harness checks anonymous and legacy-key rejection, authenticated health, cross-workspace denial for personal/shared reads and recall/write-back, shared-memory scope validation, enforcement of pending status against a forged import claim, conservative recall gating, include-unconfirmed recall, usage reporting, Agent-review denial, memory inspection, recall trace, and unsafe write-back blocking. To run actual route probes against foreign records/traces, optionally set `OB1_AGENT_MEMORY_FOREIGN_MEMORY_ID` and/or `OB1_AGENT_MEMORY_FOREIGN_REQUEST_ID` to IDs owned by another Agent or a non-allowlisted workspace; the probes are read-only and report only HTTP status, never response content. The unit suite separately exercises cross-Agent and cross-workspace record/trace ownership decisions. It prints a JSON summary and never prints the token.

For personal databases, use the cleanup harness to find or reject smoke/test memories without deleting rows:

```bash
OB1_AGENT_MEMORY_ENDPOINT="https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-memory-api" \
OB1_AGENT_MEMORY_KEY="YOUR_PER_AGENT_BEARER_TOKEN" \
OB1_AGENT_MEMORY_WORKSPACE_ID="ob1-staging" \
OB1_AGENT_MEMORY_TEST_PROJECT_IDS="agent-memory-api-smoke,agent-memory-openclaw-smoke" \
node integrations/agent-memory-api/smoke/cleanup-test-memory.mjs
```

The default mode is dry-run. Add `--apply` to mark matching active test memories as `rejected`. The harness refuses project IDs that do not look like smoke/test/sandbox scopes.

## Troubleshooting

**Issue: `Invalid or missing Agent bearer token`**

Solution: Send the Agent's unique token in `Authorization: Bearer ...`, confirm its SHA-256 digest maps to that immutable Agent ID in an enabled `agent_api_credentials` row, and ensure the token is not sent in a URL or legacy header.

**Issue: `Agent credential registry is unavailable`**

Solution: Confirm `api-credentials.sql` is applied and the function's existing service-role client has `SELECT` access to `agent_api_credentials`. No Agent credential secret needs to be configured in the Edge Function.

**Issue: `workspace_id is not authorized for this Agent`**

Solution: Confirm the exact workspace ID is present in that Agent's `workspace_ids` list. Do not work around a denial by widening the request or using another Agent's credentials.

**Issue: recall returns no memories**

Solution: Confirm write-back has created an Agent-attributed `agent_memories` row in an allowlisted workspace, and that the memory is confirmed or `include_unconfirmed` is true. Legacy rows without verified Agent attribution are deliberately excluded.

**Issue: write-back blocked as unsafe**

Solution: Store a compact summary and artifact links. Do not submit raw transcripts, reasoning traces, secrets, or large code blocks.

## Tool Surface Area

This integration exposes an API that plugins can wrap as tools. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) before adding additional runtime-specific tool surfaces.
