import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// OB1 Agent Memory MCP connector.
// A thin, stateless MCP front end for agent-memory-api. It holds NO database
// credentials: every tool call is forwarded to agent-memory-api with the
// caller's own per-Agent token, so auth, ownership isolation, capabilities,
// and usage logging are enforced in exactly one place.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

const API_BASE = (Deno.env.get("AGENT_MEMORY_API_URL") ||
  `${Deno.env.get("SUPABASE_URL")}/functions/v1/agent-memory-api`).replace(/\/+$/, "");

type AgentInfo = { agent_id: string; workspace_ids: string[]; capabilities: string[] };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const TOKEN_RE = /^[A-Za-z0-9_-]{43,512}$/;

function extractToken(req: Request): string | null {
  const header = req.headers.get("x-brain-key");
  if (header && TOKEN_RE.test(header.trim())) return header.trim();
  const auth = req.headers.get("authorization");
  const bearer = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] : null;
  if (bearer && TOKEN_RE.test(bearer)) return bearer;
  const key = new URL(req.url).searchParams.get("key");
  if (key && TOKEN_RE.test(key)) return key;
  return null;
}

async function api(
  token: string,
  tool: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-agent-memory-tool": tool,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, data };
}

async function whoami(token: string): Promise<AgentInfo | null> {
  const r = await api(token, "whoami", "GET", "/health");
  if (r.status !== 200) return null;
  const d = r.data as Partial<AgentInfo> & { ok?: boolean };
  if (!d?.ok || typeof d.agent_id !== "string" || !Array.isArray(d.workspace_ids)) return null;
  return { agent_id: d.agent_id, workspace_ids: d.workspace_ids, capabilities: d.capabilities || [] };
}

function out(r: { status: number; data: unknown }): ToolResult {
  const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
  return r.status >= 200 && r.status < 300
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text: `HTTP ${r.status}: ${text}` }], isError: true };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
}

const MEMORY_TYPES = ["decision", "output", "lesson", "constraint", "open_question", "failure", "work_log"] as const;
const PAYLOAD_KEY: Record<(typeof MEMORY_TYPES)[number], string> = {
  decision: "decisions",
  output: "outputs",
  lesson: "lessons",
  constraint: "constraints",
  open_question: "unresolved_questions",
  failure: "failures",
  work_log: "next_steps",
};

function buildServer(token: string, agent: AgentInfo): McpServer {
  const server = new McpServer({ name: "open-brain-agent-memory", version: "0.1.0" });
  const defaultWs = agent.workspace_ids[0];
  const ws = z.string().optional().describe(`Workspace ID (default: ${defaultWs})`);
  const call = (tool: string, method: string, path: string, body?: unknown) =>
    api(token, tool, method, path, body).then(out).catch(fail);
  const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
    return u.toString();
  };
  const uuid = z.string().uuid();

  server.registerTool("recall_memories", {
    title: "Recall my memories",
    description: `Semantic recall over YOUR OWN agent memories (you are '${agent.agent_id}'). Includes your personal and not-yet-reviewed memories by default. Does not search other agents or the owner's private thoughts.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().min(1).max(4000).describe("What to recall"),
      workspace_id: ws,
      project_id: z.string().optional().describe("Limit to this project"),
      max_items: z.number().int().min(1).max(50).optional(),
      include_stale: z.boolean().optional().describe("Include stale/superseded memories"),
    },
  }, ({ query, workspace_id, project_id, max_items, include_stale }) => call("recall_memories", "POST", "/recall", {
    schema_version: "openbrain.agent_memory.recall.v1",
    workspace_id: workspace_id || defaultWs,
    project_id: project_id ?? null,
    query,
    runtime: { name: "agent-memory-mcp" },
    scope: { project_only: Boolean(project_id), include_unconfirmed: true, include_stale: include_stale ?? false },
    limits: { max_items: max_items ?? 10, max_tokens: 4000 },
  }));

  server.registerTool("write_memory", {
    title: "Write a memory",
    description: "Save one private memory for yourself. Secrets, keys, and raw transcripts are rejected. Returns the new memory_id (use it with supersede_memory).",
    inputSchema: {
      content: z.string().min(1).max(15000),
      memory_type: z.enum(MEMORY_TYPES).default("lesson"),
      workspace_id: ws,
      project_id: z.string().optional(),
      task_id: z.string().max(200).optional(),
      idempotency_key: z.string().max(180).optional(),
      topics: z.array(z.string().max(80)).max(10).optional(),
    },
  }, ({ content, memory_type, workspace_id, project_id, task_id, idempotency_key, topics }) => call("write_memory", "POST", "/writeback", {
    schema_version: "openbrain.agent_memory.writeback.v1",
    workspace_id: workspace_id || defaultWs,
    project_id: project_id ?? null,
    task_id: task_id ?? null,
    idempotency_key: idempotency_key ?? null,
    runtime: { name: "agent-memory-mcp" },
    memory_payload: { [PAYLOAD_KEY[memory_type]]: [content], entities: topics?.length ? { topics } : {} },
  }));

  server.registerTool("list_memories", {
    title: "List my memories",
    description: "List your own memories, newest first, with optional filters.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      workspace_id: ws,
      project_id: z.string().optional(),
      memory_type: z.string().optional(),
      lifecycle_status: z.enum(["active", "stale", "superseded", "disputed", "rejected"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, (a) => call("list_memories", "GET", `/memories?${qs({ ...a, workspace_id: a.workspace_id || defaultWs })}`));

  server.registerTool("get_memory", {
    title: "Get one of my memories",
    description: "Fetch one of your own memories by memory_id, with sources and artifacts.",
    annotations: { readOnlyHint: true },
    inputSchema: { memory_id: uuid },
  }, ({ memory_id }) => call("get_memory", "GET", `/memories/${memory_id}`));

  server.registerTool("supersede_memory", {
    title: "Supersede a memory",
    description: "Mark one of your older memories as superseded by a newer one (write the new one first with write_memory).",
    inputSchema: { old_memory_id: uuid, new_memory_id: uuid, notes: z.string().max(1000).optional() },
  }, ({ old_memory_id, new_memory_id, notes }) => call("supersede_memory", "PATCH", `/memories/${old_memory_id}/review`, {
    action: "supersede", related_memory_id: new_memory_id, notes: notes ?? null,
  }));

  server.registerTool("forget_memory", {
    title: "Forget a memory",
    description: "Permanently delete one of your own memories.",
    annotations: { destructiveHint: true },
    inputSchema: { memory_id: uuid },
  }, ({ memory_id }) => call("forget_memory", "DELETE", `/memories/${memory_id}`));

  server.registerTool("acquire_lock", {
    title: "Acquire a work lock",
    description: "Claim a named lock so other agents don't duplicate work. Fails (HTTP 409) with the current holder if another agent holds it. Re-acquiring your own lock renews it.",
    inputSchema: {
      lock_key: z.string().min(1).max(200),
      ttl_seconds: z.number().int().min(10).max(86400).optional(),
      note: z.string().max(500).optional(),
      workspace_id: ws,
    },
  }, ({ lock_key, ttl_seconds, note, workspace_id }) => call("acquire_lock", "POST", "/locks/acquire", {
    workspace_id: workspace_id || defaultWs, lock_key, ttl_seconds: ttl_seconds ?? 900, note: note ?? null,
  }));

  server.registerTool("release_lock", {
    title: "Release a work lock",
    description: "Release a lock you hold.",
    inputSchema: { lock_key: z.string().min(1).max(200), workspace_id: ws },
  }, ({ lock_key, workspace_id }) => call("release_lock", "POST", "/locks/release", {
    workspace_id: workspace_id || defaultWs, lock_key,
  }));

  server.registerTool("list_shared_memories", {
    title: "List shared memories",
    description: "List memories shared across agents. Approved ones by default; set include_unconfirmed to also see pending ones.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      workspace_id: ws,
      sharing_scope: z.enum(["project", "workspace", "organization"]).optional(),
      project_id: z.string().optional().describe("Required for project scope"),
      include_unconfirmed: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (a) => call("list_shared_memories", "GET", `/shared-memories?${qs({ ...a, workspace_id: a.workspace_id || defaultWs })}`));

  server.registerTool("write_shared_memory", {
    title: "Share a memory",
    description: "Propose a memory for all agents. It stays pending until approved by an approver. Organization scope requires the shared:approve capability.",
    inputSchema: {
      summary: z.string().min(1).max(500),
      content: z.string().min(1).max(15000),
      memory_type: z.enum([...MEMORY_TYPES, "artifact_reference"]).default("lesson"),
      sharing_scope: z.enum(["project", "workspace", "organization"]).default("workspace"),
      project_id: z.string().optional().describe("Required for project scope"),
      workspace_id: ws,
      idempotency_key: z.string().max(180).optional(),
    },
  }, (a) => call("write_shared_memory", "POST", "/shared-memories", {
    workspace_id: a.workspace_id || defaultWs,
    project_id: a.sharing_scope === "project" ? a.project_id ?? null : null,
    sharing_scope: a.sharing_scope,
    memory_type: a.memory_type,
    summary: a.summary,
    content: a.content,
    ...(a.idempotency_key ? { idempotency_key: a.idempotency_key } : {}),
  }));

  if (agent.capabilities.includes("shared:approve")) {
    server.registerTool("approve_shared_memory", {
      title: "Approve a shared memory",
      description: "Approve a pending shared memory so all agents see it (requires shared:approve).",
      inputSchema: {
        shared_memory_id: uuid,
        review_status: z.enum(["confirmed", "evidence_only"]).optional(),
        notes: z.string().max(1000).optional(),
      },
    }, ({ shared_memory_id, review_status, notes }) => call("approve_shared_memory", "POST", `/shared-memories/${shared_memory_id}/approve`, {
      review_status: review_status ?? "confirmed", notes: notes ?? null,
    }));
  }

  return server;
}

// --- HTTP layer (same conventions as server/index.ts) ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Cache-Control": "no-store",
};

function unauthorized(id: string | number | null): Response {
  // JSON-RPC envelope (HTTP 200) so strict MCP hosts keep the connection alive.
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid agent token." }, id }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function jsonRpcId(req: Request): Promise<string | number | null> {
  if (req.method !== "POST") return null;
  try {
    const parsed = JSON.parse(await req.clone().text());
    const id = parsed?.id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

const app = new Hono();
app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const token = extractToken(c.req.raw);
  const agent = token ? await whoami(token).catch(() => null) : null;
  if (!token || !agent) {
    // Plain HTTP 401 for non-MCP probes; JSON-RPC envelope for MCP POSTs.
    if (c.req.method !== "POST") return c.json({ error: "Unauthorized" }, 401, corsHeaders);
    return unauthorized(await jsonRpcId(c.req.raw));
  }

  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const server = buildServer(token, agent);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

Deno.serve(app.fetch);
