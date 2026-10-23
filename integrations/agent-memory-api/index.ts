import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  authenticateAgent,
  hasCapability,
  isWorkspaceAllowed,
  ownsPersonalMemory,
  ownsRecallTrace,
} from "./auth.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = { "Cache-Control": "no-store" };

const runtimeSchema = z.object({
  name: z.string().default("unknown"),
  version: z.string().nullable().optional(),
});

const channelSchema = z.object({
  kind: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
});

const recallSchemaVersion = z.union([
  z.literal("openbrain.agent_memory.recall.v1"),
  z.literal("openbrain.openclaw.recall.v1"),
]);

const writebackSchemaVersion = z.union([
  z.literal("openbrain.agent_memory.writeback.v1"),
  z.literal("openbrain.openclaw.writeback.v1"),
]);

const recallSchema = z.object({
  schema_version: recallSchemaVersion,
  workspace_id: z.string().min(1),
  project_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  flow_id: z.string().nullable().optional(),
  task_type: z.string().nullable().optional(),
  channel: channelSchema.default({}),
  runtime: runtimeSchema.default({ name: "unknown" }),
  model_intent: z.object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  }).default({}),
  query: z.string().min(1).max(4000),
  entities: z.record(z.string(), z.array(z.string())).default({}),
  scope: z.object({
    visibility: z.string().nullable().optional(),
    project_only: z.boolean().default(true),
    // Recall is always scoped to the calling Agent's own memories, so its own
    // pending (unreviewed) memories are included by default.
    include_unconfirmed: z.boolean().default(true),
    include_stale: z.boolean().default(false),
  }).default({ project_only: true, include_unconfirmed: true, include_stale: false }),
  limits: z.object({
    max_items: z.number().int().min(1).max(50).default(10),
    max_tokens: z.number().int().min(256).max(20000).default(4000),
    recency_days: z.number().int().positive().nullable().optional(),
  }).default({ max_items: 10, max_tokens: 4000 }),
  sensitivity: z.record(z.string(), z.boolean()).default({}),
});

const memoryText = z.string().min(1).max(15000);
const memoryList = z.array(memoryText).max(20).default([]);
const memoryPayloadSchema = z.object({
  decisions: memoryList,
  outputs: memoryList,
  lessons: memoryList,
  constraints: memoryList,
  unresolved_questions: memoryList,
  next_steps: memoryList,
  failures: memoryList,
  artifacts: z.array(z.object({
    kind: z.string(),
    uri: z.string(),
    description: z.string().nullable().optional(),
  })).max(20).default([]),
  entities: z.record(z.string(), z.array(z.string())).default({}),
});

const writebackSchema = z.object({
  schema_version: writebackSchemaVersion,
  workspace_id: z.string().min(1),
  project_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  flow_id: z.string().nullable().optional(),
  step_id: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  content_hash: z.string().nullable().optional(),
  channel: channelSchema.default({}),
  runtime: runtimeSchema.default({ name: "unknown" }),
  models_used: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    role: z.string(),
  })).default([]),
  source_refs: z.array(z.object({
    kind: z.string(),
    uri: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    timestamp: z.string().nullable().optional(),
  })).default([]),
  memory_payload: memoryPayloadSchema,
  provenance: z.object({
    default_status: z.enum(["observed", "inferred", "user_confirmed", "imported", "generated"]).default("generated"),
    confidence: z.number().min(0).max(1).default(0.5),
    requires_review: z.boolean().default(true),
  }).default({ default_status: "generated", confidence: 0.5, requires_review: true }),
  retention: z.object({
    ttl_days: z.number().int().positive().nullable().optional(),
    stale_after_days: z.number().int().positive().nullable().optional(),
  }).default({}),
  visibility: z.object({
    workspace: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
    channel: z.string().nullable().optional(),
  }).default({}),
});

const usageSchema = z.object({
  used_memory_ids: z.array(z.string()).default([]),
  ignored: z.array(z.object({
    memory_id: z.string(),
    reason: z.string().optional(),
  })).default([]),
});

const reviewSchema = z.object({
  action: z.enum(["confirm", "edit", "evidence_only", "restrict_scope", "mark_stale", "merge", "reject", "dispute", "supersede"]),
  actor_id: z.string().nullable().optional(),
  actor_label: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  visibility: z.string().optional(),
  related_memory_id: z.string().uuid().optional(),
});

const lockSchema = z.object({
  workspace_id: z.string().min(1).max(200),
  lock_key: z.string().min(1).max(200),
  ttl_seconds: z.number().int().min(10).max(86400).default(900),
  note: z.string().max(500).nullable().optional(),
});

function serverError(c: { json: (b: unknown, s: 500, h: Record<string, string>) => Response }, err: unknown) {
  console.error("agent-memory-api error:", err);
  return c.json({ error: "Internal error" }, 500, corsHeaders);
}

const sharedMemorySchema = z.object({
  workspace_id: z.string().min(1).max(200),
  project_id: z.string().min(1).max(200).nullable().optional(),
  sharing_scope: z.enum(["project", "workspace", "organization"]).default("project"),
  memory_type: z.enum(["decision", "output", "lesson", "constraint", "open_question", "failure", "artifact_reference", "work_log"]),
  summary: z.string().min(1).max(500),
  content: z.string().min(1).max(15000),
  provenance_status: z.enum(["observed", "inferred", "generated"]).default("generated"),
  confidence: z.number().min(0).max(1).default(0.5),
  idempotency_key: z.string().min(1).max(180).nullable().optional(),
});

type AppEnv = { Variables: { agentId: string; workspaceIds: string[]; capabilities: string[] } };

type AgentMemory = {
  id: string;
  thought_id: string | null;
  workspace_id: string;
  project_id: string | null;
  channel_id: string | null;
  visibility: string;
  memory_type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  provenance_status: string;
  confidence: number;
  created_by: string;
  runtime_name: string | null;
  runtime_version: string | null;
  provider: string | null;
  model: string | null;
  task_id: string | null;
  flow_id: string | null;
  can_use_as_instruction: boolean;
  can_use_as_evidence: boolean;
  requires_user_confirmation: boolean;
  review_status: string;
  last_confirmed_at: string | null;
  stale_after: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  similarity?: number;
};

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter embeddings failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.data[0].embedding;
}

function unsafeReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(text)) reasons.push("private_key");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(text)) reasons.push("api_key");
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(text)) reasons.push("credential_like_string");
  if ((text.match(/```/g) || []).length >= 4 || text.split("\n").filter((l) => l.length > 120).length > 20) reasons.push("large_code_block");
  if (text.length > 15000 || text.split("\n").filter((l) => /^(user|assistant|system|agent|human):/i.test(l.trim())).length > 8) reasons.push("raw_transcript_like");
  return reasons;
}

function staleAfter(days?: number | null): string | null {
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function memoryRows(payload: z.infer<typeof writebackSchema>) {
  const p = payload.memory_payload;
  const rows: { memory_type: string; content: string }[] = [];
  for (const content of p.decisions) rows.push({ memory_type: "decision", content });
  for (const content of p.outputs) rows.push({ memory_type: "output", content });
  for (const content of p.lessons) rows.push({ memory_type: "lesson", content });
  for (const content of p.constraints) rows.push({ memory_type: "constraint", content });
  for (const content of p.unresolved_questions) rows.push({ memory_type: "open_question", content });
  for (const content of p.next_steps) rows.push({ memory_type: "work_log", content: `Next step: ${content}` });
  for (const content of p.failures) rows.push({ memory_type: "failure", content });
  for (const artifact of p.artifacts) {
    rows.push({
      memory_type: "artifact_reference",
      content: `${artifact.kind}: ${artifact.description || artifact.uri}\n${artifact.uri}`,
    });
  }
  return rows;
}

function scopeMatches(memory: AgentMemory, req: z.infer<typeof recallSchema>): boolean {
  if (memory.workspace_id !== req.workspace_id) return false;
  if (req.scope.project_only && req.project_id && memory.project_id !== req.project_id) return false;
  if (!req.scope.include_stale && ["stale", "superseded", "rejected", "disputed"].includes(memory.lifecycle_status)) return false;
  if (!req.scope.include_unconfirmed && memory.requires_user_confirmation && memory.review_status === "pending") return false;
  // Personal visibility is not filtered: recall only ever returns the caller's own memories.
  if (req.scope.visibility && req.scope.visibility !== memory.visibility) return false;
  return true;
}

function rankMemory(memory: AgentMemory, similarity = 0): number {
  const provenance = memory.provenance_status === "user_confirmed" ? 0.3
    : memory.provenance_status === "imported" ? 0.22
    : memory.provenance_status === "observed" ? 0.15
    : memory.provenance_status === "generated" ? 0.05
    : 0;
  const policy = memory.can_use_as_instruction ? 0.2 : memory.can_use_as_evidence ? 0.08 : -0.2;
  const review = memory.review_status === "confirmed" ? 0.15
    : memory.review_status === "evidence_only" ? 0.05
    : memory.review_status === "pending" ? -0.08
    : -0.25;
  return similarity + provenance + policy + review + Number(memory.confidence || 0) * 0.15;
}

function responseMemory(memory: AgentMemory) {
  return {
    memory_id: memory.id,
    summary: memory.summary,
    content: memory.content,
    source: {
      kind: "agent_memory",
      uri: null,
      title: memory.summary,
      timestamp: memory.created_at,
    },
    provenance: {
      status: memory.provenance_status,
      confidence: Number(memory.confidence),
      created_by: memory.created_by,
      model: memory.model,
      runtime: memory.runtime_name,
    },
    scope: {
      workspace_id: memory.workspace_id,
      project_id: memory.project_id,
      channel_id: memory.channel_id,
      visibility: memory.visibility,
    },
    use_policy: {
      can_use_as_instruction: memory.can_use_as_instruction,
      can_use_as_evidence: memory.can_use_as_evidence,
      requires_user_confirmation: memory.requires_user_confirmation,
    },
    freshness: {
      created_at: memory.created_at,
      last_confirmed_at: memory.last_confirmed_at,
      stale_after: memory.stale_after,
    },
    related_artifacts: [],
  };
}

function responseSharedMemory(memory: Record<string, unknown>) {
  return {
    memory_id: memory.id,
    summary: memory.summary,
    content: memory.content,
    memory_type: memory.memory_type,
    scope: {
      workspace_id: memory.workspace_id,
      project_id: memory.project_id,
      sharing_scope: memory.sharing_scope,
    },
    provenance: {
      status: memory.provenance_status,
      confidence: Number(memory.confidence),
      created_by_agent: memory.created_by_agent,
    },
    use_policy: {
      can_use_as_instruction: memory.can_use_as_instruction,
      can_use_as_evidence: memory.can_use_as_evidence,
      requires_user_confirmation: memory.requires_user_confirmation,
    },
    review_status: memory.review_status,
    lifecycle_status: memory.lifecycle_status,
    freshness: {
      created_at: memory.created_at,
      updated_at: memory.updated_at,
    },
  };
}

function recallResponseSchema(reqSchemaVersion: string) {
  return reqSchemaVersion === "openbrain.openclaw.recall.v1"
    ? "openbrain.openclaw.recall_response.v1"
    : "openbrain.agent_memory.recall_response.v1";
}

function writebackResponseSchema(reqSchemaVersion: string) {
  return reqSchemaVersion === "openbrain.openclaw.writeback.v1"
    ? "openbrain.openclaw.writeback_response.v1"
    : "openbrain.agent_memory.writeback_response.v1";
}

async function audit(event_type: string, payload: Record<string, unknown>) {
  await supabase.from("agent_memory_audit_events").insert({
    event_type,
    workspace_id: payload.workspace_id ?? null,
    project_id: payload.project_id ?? null,
    memory_id: payload.memory_id ?? null,
    trace_id: payload.trace_id ?? null,
    actor_kind: payload.actor_kind ?? "system",
    actor_label: payload.actor_label ?? null,
    runtime_name: payload.runtime_name ?? null,
    task_id: payload.task_id ?? null,
    payload,
  });
}

// --- Wellness log (Honey only) ---
// Personal health data. Never written to agent_memory_audit_events, thoughts,
// shared memories, or console logs; always scoped to owner === agentId.

const WELLNESS_AGENT_IDS = new Set(["honey"]);
const TORONTO_TZ = "America/Toronto";
const WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WELLNESS_FIELD_KEYS = [
  "kind", "energy", "hunger", "alertness", "food_text", "food_size",
  "caffeine", "alcohol", "note", "source", "tunnel_progress", "logged_at",
] as const;

function requireWellnessAgent(c: { get: (k: "agentId") => string; json: (b: unknown, s: 403, h: Record<string, string>) => Response }): Response | null {
  if (!WELLNESS_AGENT_IDS.has(c.get("agentId"))) {
    return c.json({ error: "wellness tools are restricted to Honey" }, 403, corsHeaders);
  }
  return null;
}

// Wellness rows can carry health data in Postgres error detail (e.g. "Failing row contains (...)").
// Never log the error object itself, only its code.
function wellnessServerError(c: { json: (b: unknown, s: 500, h: Record<string, string>) => Response }, err: unknown) {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  console.error("agent-memory-api wellness error:", code);
  return c.json({ error: "Internal error" }, 500, corsHeaders);
}

type WellnessFields = {
  kind: string;
  energy?: number | null;
  hunger?: number | null;
  alertness?: number | null;
  food_text?: string | null;
  food_size?: string | null;
  caffeine?: boolean | null;
  alcohol?: boolean | null;
  tunnel_progress?: string | null;
};

function wellnessRuleErrors(v: WellnessFields): string[] {
  const errors: string[] = [];
  const hasScore = v.energy != null || v.hunger != null || v.alertness != null;
  const hasFoodFields = v.food_text != null || v.food_size != null || v.caffeine != null || v.alcohol != null;
  if (v.kind === "food" && !v.food_text) errors.push("kind 'food' requires food_text");
  if (v.kind === "missed" && (hasScore || hasFoodFields)) errors.push("kind 'missed' must not carry scores or food fields");
  if (v.kind === "check_in" && !hasScore && !v.tunnel_progress) errors.push("kind 'check_in' requires at least one of energy/hunger/alertness or tunnel_progress");
  if (v.kind !== "food" && (v.food_size != null || v.caffeine != null || v.alcohol != null)) errors.push("food_size/caffeine/alcohol are only allowed for kind 'food'");
  return errors;
}

const wellnessFieldsSchema = z.object({
  kind: z.enum(["check_in", "food", "missed"]),
  energy: z.number().int().min(1).max(5).nullable().optional(),
  hunger: z.number().int().min(1).max(5).nullable().optional(),
  alertness: z.number().int().min(1).max(5).nullable().optional(),
  food_text: z.string().min(1).max(2000).nullable().optional(),
  food_size: z.enum(["small", "medium", "large"]).nullable().optional(),
  caffeine: z.boolean().nullable().optional(),
  alcohol: z.boolean().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  source: z.enum(["prompted", "unprompted"]).nullable().optional(),
  tunnel_progress: z.enum(["yes", "a bit", "no"]).nullable().optional(),
  logged_at: z.string().datetime({ offset: true }).nullable().optional(),
});

const wellnessInsertSchema = wellnessFieldsSchema.strict().superRefine((data, ctx) => {
  for (const message of wellnessRuleErrors(data)) ctx.addIssue({ code: "custom", message });
});

const wellnessPatchSchema = wellnessFieldsSchema.partial().extend({ confirm: z.boolean() }).strict();

// Offset (minutes) such that localTime = utcInstant + offset, for the given zone at that instant.
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) % 24, Number(map.minute), Number(map.second));
  return (asUTC - instant.getTime()) / 60000;
}

// UTC instant of local midnight on dateStr ("YYYY-MM-DD") in timeZone, DST-correct.
function localMidnightUTC(dateStr: string, timeZone: string): Date {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const offset1 = tzOffsetMinutes(guess, timeZone);
  const utc1 = new Date(guess.getTime() - offset1 * 60000);
  const offset2 = tzOffsetMinutes(utc1, timeZone);
  return offset2 === offset1 ? utc1 : new Date(guess.getTime() - offset2 * 60000);
}

function getLocalHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" })
    .formatToParts(instant).find((p) => p.type === "hour")?.value ?? "0";
  return Number(hour) % 24;
}

function getLocalWeekday(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(instant);
}

function getLocalDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function localTimeLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return `${getLocalDate(instant, timeZone)} ${String(Number(map.hour) % 24).padStart(2, "0")}:${map.minute}`;
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function resolveWellnessRange(c: { req: { query: (k: string) => string | undefined }; json: (b: unknown, s: 400, h: Record<string, string>) => Response }): { from: string; to: string } | Response {
  const todayLocal = getLocalDate(new Date(), TORONTO_TZ);
  const from = c.req.query("from") ?? addDaysToDateStr(todayLocal, -14);
  const to = c.req.query("to") ?? todayLocal;
  if (!isValidDateStr(from) || !isValidDateStr(to)) return c.json({ error: "from/to must be YYYY-MM-DD" }, 400, corsHeaders);
  if (to < from) return c.json({ error: "to must be >= from" }, 400, corsHeaders);
  const rangeDays = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000);
  if (rangeDays > 366) return c.json({ error: "from/to range must be <= 366 days" }, 400, corsHeaders);
  return { from, to };
}

type WellnessRow = {
  id: string;
  kind: string;
  logged_at: string;
  energy: number | null;
  hunger: number | null;
  alertness: number | null;
  food_text: string | null;
  tunnel_progress: string | null;
};

// PostgREST caps a single response at 1000 rows, so callers that need more must page with .range().
async function fetchWellnessRows(
  agentId: string,
  startIso: string,
  endIso: string,
  maxRows: number,
  kind?: string,
): Promise<{ data: WellnessRow[] | null; error: { code?: string } | null }> {
  const rows: WellnessRow[] = [];
  let offset = 0;
  while (rows.length < maxRows) {
    let q = supabase
      .from("agent_wellness_log")
      .select("*")
      .eq("owner", agentId)
      .gte("logged_at", startIso)
      .lt("logged_at", endIso)
      .order("logged_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q;
    if (error) return { data: null, error };
    rows.push(...((data || []) as WellnessRow[]));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }
  return { data: rows.slice(0, maxRows), error: null };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]);
}

function summarizeWellness(rows: WellnessRow[], from: string, to: string) {
  const checkIns = rows.filter((r) => r.kind === "check_in");
  const foods = rows
    .filter((r) => r.kind === "food")
    .map((r) => new Date(r.logged_at).getTime())
    .sort((a, b) => a - b);
  const missed = rows.filter((r) => r.kind === "missed");

  const counts = {
    check_in: checkIns.length,
    food: rows.filter((r) => r.kind === "food").length,
    missed: missed.length,
    total: rows.length,
  };

  const hourBuckets = new Map<number, { n: number; energy: number[]; hunger: number[]; alertness: number[] }>();
  const weekdayBuckets = new Map<string, { n: number; energy: number[]; hunger: number[]; alertness: number[] }>();
  for (const row of checkIns) {
    const instant = new Date(row.logged_at);
    const hour = getLocalHour(instant, TORONTO_TZ);
    const weekday = getLocalWeekday(instant, TORONTO_TZ);
    const hourBucket = hourBuckets.get(hour) ?? { n: 0, energy: [], hunger: [], alertness: [] };
    const weekdayBucket = weekdayBuckets.get(weekday) ?? { n: 0, energy: [], hunger: [], alertness: [] };
    for (const bucket of [hourBucket, weekdayBucket]) {
      bucket.n += 1;
      if (row.energy != null) bucket.energy.push(row.energy);
      if (row.hunger != null) bucket.hunger.push(row.hunger);
      if (row.alertness != null) bucket.alertness.push(row.alertness);
    }
    hourBuckets.set(hour, hourBucket);
    weekdayBuckets.set(weekday, weekdayBucket);
  }
  const by_hour = [...hourBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({ hour, n: b.n, avg_energy: average(b.energy), avg_hunger: average(b.hunger), avg_alertness: average(b.alertness) }));
  const by_weekday = WEEKDAY_ORDER.filter((wd) => weekdayBuckets.has(wd)).map((weekday) => {
    const b = weekdayBuckets.get(weekday)!;
    return { weekday, n: b.n, avg_energy: average(b.energy), avg_hunger: average(b.hunger), avg_alertness: average(b.alertness) };
  });

  const lowCheckIns = checkIns.filter((r) => (r.energy != null && r.energy <= 2) || (r.alertness != null && r.alertness <= 2));
  let withoutPriorFood = 0;
  const hoursSinceFood: number[] = [];
  for (const row of lowCheckIns) {
    const t = new Date(row.logged_at).getTime();
    let latest: number | null = null;
    for (const foodTime of foods) {
      if (foodTime <= t) latest = foodTime;
      else break;
    }
    const hours = latest == null ? null : (t - latest) / 3600000;
    if (hours == null || hours > 24) withoutPriorFood += 1;
    else hoursSinceFood.push(hours);
  }
  const low_points = {
    n: lowCheckIns.length,
    median_hours_since_food: median(hoursSinceFood),
    avg_hours_since_food: average(hoursSinceFood),
    without_prior_food: withoutPriorFood,
  };

  const windowValues: number[][] = Array.from({ length: 24 }, () => []);
  for (const row of checkIns) {
    if (row.energy == null && row.alertness == null) continue;
    const parts = [row.energy, row.alertness].filter((v): v is number => v != null);
    const score = parts.reduce((a, b) => a + b, 0) / parts.length;
    const hour = getLocalHour(new Date(row.logged_at), TORONTO_TZ);
    windowValues[hour].push(score);
    windowValues[(hour - 1 + 24) % 24].push(score);
  }
  const allWindows = windowValues.map((values, h) => ({
    start_hour: h,
    end_hour: (h + 2) % 24,
    label: `${String(h).padStart(2, "0")}:00-${String((h + 2) % 24).padStart(2, "0")}:00`,
    n: values.length,
    score: average(values),
  }));
  const eligible = allWindows.filter((w) => w.n >= 2 && w.score != null);
  const pool = eligible.length > 0 ? eligible : allWindows.filter((w) => w.n >= 1 && w.score != null);
  const best_window = pool.length > 0 ? pool.reduce((a, b) => (b.score! > a.score! ? b : a)) : null;
  const worst_window = pool.length > 0 ? pool.reduce((a, b) => (b.score! < a.score! ? b : a)) : null;

  const tunnel_progress = { yes: 0, "a bit": 0, no: 0 };
  for (const row of rows) {
    if (row.tunnel_progress === "yes") tunnel_progress.yes += 1;
    else if (row.tunnel_progress === "a bit") tunnel_progress["a bit"] += 1;
    else if (row.tunnel_progress === "no") tunnel_progress.no += 1;
  }

  return {
    range: { from, to, time_zone: TORONTO_TZ },
    counts,
    by_hour,
    by_weekday,
    low_points,
    windows_2h: { best_window, worst_window, all: allWindows },
    missed_check_ins: counts.missed,
    tunnel_progress,
  };
}

const app = new Hono<AppEnv>();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.use("*", async (c, next) => {
  let agent;
  try {
    agent = await authenticateAgent(c.req.header("authorization"), async (tokenDigest: string) => {
      const { data, error } = await supabase
        .from("agent_api_credentials")
        .select("agent_id, token_sha256, workspace_ids, enabled, capabilities")
        .eq("token_sha256", tokenDigest)
        .eq("enabled", true)
        .maybeSingle();
      if (error) throw new Error("Agent credential registry lookup failed");
      return data;
    });
  } catch {
    return c.json({ error: "Agent credential registry is unavailable" }, 503, corsHeaders);
  }
  if (!agent) return c.json({ error: "Invalid or missing Agent bearer token" }, 401, corsHeaders);
  c.set("agentId", agent.agentId);
  c.set("workspaceIds", agent.workspaceIds);
  c.set("capabilities", agent.capabilities);
  await next();
  if (c.req.path !== "/health") {
    // Per-key usage log. Endpoint is the matched route, or the MCP tool name when proxied.
    const tool = c.req.header("x-agent-memory-tool");
    const endpoint = tool && /^[a-z_]{1,64}$/.test(tool) ? `mcp:${tool}` : `${c.req.method} ${c.req.routePath}`;
    const { error } = await supabase.from("agent_api_key_usage").insert({ agent_id: agent.agentId, endpoint, status: c.res.status });
    if (error) console.error("usage log failed:", error.message);
  }
});

app.get("/health", (c) => c.json({
  ok: true,
  service: "agent-memory-api",
  version: "0.5.0",
  agent_id: c.get("agentId"),
  workspace_ids: c.get("workspaceIds"),
  capabilities: c.get("capabilities"),
}, 200, corsHeaders));

app.post("/recall", async (c) => {
  const parsed = recallSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid recall payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  if (!isWorkspaceAllowed(agent.workspaceIds, req.workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }

  const embedding = await getEmbedding(req.query);
  const { data: matches, error: matchError } = await supabase.rpc("match_agent_memories", {
    query_embedding: embedding,
    p_workspace_id: req.workspace_id,
    p_agent_id: agent.agentId,
    match_threshold: 0.25,
    match_count: Math.max(req.limits.max_items * 4, 20),
  });
  if (matchError) return serverError(c, matchError);

  const similarityByMemory = new Map<string, number>();
  for (const item of matches || []) similarityByMemory.set(item.id, item.similarity);
  const memoryIds = Array.from(similarityByMemory.keys());

  let memoryQuery = supabase
    .from("agent_memories")
    .select("*")
    .eq("workspace_id", req.workspace_id)
    .eq("metadata->>authenticated_agent_id", agent.agentId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (memoryIds.length > 0) memoryQuery = memoryQuery.in("id", memoryIds);

  const { data: rawMemories, error: memoryError } = await memoryQuery;
  if (memoryError) return serverError(c, memoryError);

  const ranked = ((rawMemories || []) as AgentMemory[])
    .filter((m) => ownsPersonalMemory(agent, m.workspace_id, m.metadata) && scopeMatches(m, req))
    .map((m) => {
      const similarity = similarityByMemory.get(m.id) || 0;
      return { ...m, similarity, ranking_score: rankMemory(m, similarity) };
    })
    .sort((a, b) => b.ranking_score - a.ranking_score)
    .slice(0, req.limits.max_items);

  const { data: trace, error: traceError } = await supabase.from("agent_memory_recall_traces").insert({
    workspace_id: req.workspace_id,
    project_id: req.project_id ?? null,
    runtime_name: req.runtime.name,
    runtime_version: req.runtime.version ?? null,
    task_id: req.task_id ?? null,
    flow_id: req.flow_id ?? null,
    channel_kind: req.channel.kind ?? null,
    channel_id: req.channel.id ?? null,
    query: req.query,
    schema_version: req.schema_version,
    request_payload: { ...req, authenticated_agent_id: agent.agentId },
    response_policy: { max_items: req.limits.max_items, include_unconfirmed: req.scope.include_unconfirmed },
  }).select("*").single();
  if (traceError) return serverError(c, traceError);

  if (ranked.length > 0) {
    await supabase.from("agent_memory_recall_items").insert(ranked.map((memory, index) => ({
      trace_id: trace.id,
      memory_id: memory.id,
      rank: index + 1,
      similarity: memory.similarity,
      ranking_score: memory.ranking_score,
      use_policy_snapshot: {
        can_use_as_instruction: memory.can_use_as_instruction,
        can_use_as_evidence: memory.can_use_as_evidence,
        requires_user_confirmation: memory.requires_user_confirmation,
      },
    })));
  }

  await audit("recall_requested", {
    workspace_id: req.workspace_id,
    project_id: req.project_id,
    trace_id: trace.id,
    runtime_name: req.runtime.name,
    task_id: req.task_id,
    returned_count: ranked.length,
  });

  return c.json({
    schema_version: recallResponseSchema(req.schema_version),
    request_id: trace.request_id,
    memories: ranked.map(responseMemory),
  }, 200, corsHeaders);
});

app.post("/writeback", async (c) => {
  const parsed = writebackSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid write-back payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  const authenticatedAgentId = c.get("agentId");
  if (!isWorkspaceAllowed(c.get("workspaceIds"), req.workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }
  const rows = memoryRows(req);
  if (rows.length === 0) return c.json({ error: "memory_payload produced no memory rows" }, 400, corsHeaders);

  const unsafe = rows.flatMap((row) => unsafeReasons(row.content).map((reason) => ({ reason, memory_type: row.memory_type })));
  if (unsafe.length > 0) {
    await audit("memory_rejected", {
      workspace_id: req.workspace_id,
      project_id: req.project_id,
      runtime_name: req.runtime.name,
      task_id: req.task_id,
      actor_kind: "system",
      reason: "unsafe_writeback",
      unsafe,
    });
    return c.json({ error: "Unsafe write-back blocked", unsafe }, 422, corsHeaders);
  }

  const created = [];
  const provider = req.models_used[0]?.provider ?? null;
  const model = req.models_used[0]?.model ?? null;
  const effectiveProvenanceStatus = ["observed", "inferred"].includes(req.provenance.default_status)
    ? req.provenance.default_status
    : "generated";

  for (const [index, row] of rows.entries()) {
    const content_hash = await sha256Hex(`${row.memory_type}:${row.content}`);
    const baseKey = req.idempotency_key || `${req.workspace_id}:${req.runtime.name}:${req.task_id || "taskless"}:${req.step_id || "step"}:${content_hash}`;
    const idempotency_key = await sha256Hex(`${authenticatedAgentId}:${req.workspace_id}:${baseKey}:${index}`);

    const { data: existing } = await supabase
      .from("agent_memories")
      .select("*")
      .eq("idempotency_key", idempotency_key)
      .eq("workspace_id", req.workspace_id)
      .eq("metadata->>authenticated_agent_id", authenticatedAgentId)
      .maybeSingle();
    if (existing) {
      created.push(existing);
      continue;
    }

    // Agent memories keep their own embedding; public.thoughts (the user's brain) is never touched.
    const embedding = await getEmbedding(row.content);

    const { data: memory, error: memoryError } = await supabase.from("agent_memories").insert({
      thought_id: null,
      embedding,
      workspace_id: req.workspace_id,
      project_id: req.project_id ?? null,
      channel_kind: req.channel.kind ?? null,
      channel_id: req.channel.id ?? null,
      channel_thread_id: req.channel.thread_id ?? null,
      visibility: req.project_id ? "project" : "personal",
      memory_type: row.memory_type,
      summary: row.content.replace(/\s+/g, " ").slice(0, 140),
      content: row.content,
      provenance_status: effectiveProvenanceStatus,
      confidence: req.provenance.confidence,
      created_by: "agent",
      runtime_name: req.runtime.name,
      runtime_version: req.runtime.version ?? null,
      provider,
      model,
      task_id: req.task_id ?? null,
      flow_id: req.flow_id ?? null,
      can_use_as_instruction: false,
      can_use_as_evidence: true,
      requires_user_confirmation: true,
      review_status: "pending",
      last_confirmed_at: null,
      stale_after: staleAfter(req.retention.stale_after_days),
      idempotency_key,
      content_hash,
      metadata: {
        authenticated_agent_id: authenticatedAgentId,
        source_refs: req.source_refs,
        models_used: req.models_used,
        retention: req.retention,
        writeback_schema_version: req.schema_version,
      },
    }).select("*").single();
    if (memoryError) return serverError(c, memoryError);

    if (req.source_refs.length > 0) {
      await supabase.from("agent_memory_source_refs").insert(req.source_refs.map((source) => ({
        memory_id: memory.id,
        source_kind: source.kind,
        uri: source.uri ?? null,
        title: source.title ?? null,
        source_timestamp: source.timestamp ?? null,
      })));
    }

    if (row.memory_type === "artifact_reference") {
      for (const artifact of req.memory_payload.artifacts) {
        await supabase.from("agent_memory_artifacts").insert({
          memory_id: memory.id,
          artifact_kind: artifact.kind,
          uri: artifact.uri,
          description: artifact.description ?? null,
        });
      }
    }

    await audit("memory_written", {
      workspace_id: req.workspace_id,
      project_id: req.project_id,
      memory_id: memory.id,
      runtime_name: req.runtime.name,
      actor_label: authenticatedAgentId,
      task_id: req.task_id,
      actor_kind: "agent",
      provenance_status: effectiveProvenanceStatus,
      review_status: memory.review_status,
    });
    created.push(memory);
  }

  return c.json({ schema_version: writebackResponseSchema(req.schema_version), memories: created.map(responseMemory) }, 200, corsHeaders);
});

app.post("/recall/:request_id/usage", async (c) => {
  const request_id = c.req.param("request_id");
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  const parsed = usageSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid usage payload", details: parsed.error.flatten() }, 400, corsHeaders);

  const { data: trace, error } = await supabase
    .from("agent_memory_recall_traces")
    .select("*")
    .eq("request_id", request_id)
    .eq("request_payload->>authenticated_agent_id", agent.agentId)
    .maybeSingle();
  if (error || !trace || !ownsRecallTrace(agent, trace)) {
    return c.json({ error: "Recall trace not found" }, 404, corsHeaders);
  }

  const { data: traceItems, error: traceItemsError } = await supabase
    .from("agent_memory_recall_items")
    .select("memory_id")
    .eq("trace_id", trace.id);
  if (traceItemsError) return serverError(c, traceItemsError);
  const candidateMemoryIds = [...new Set((traceItems || []).map((item) => item.memory_id))];
  let traceMemoryIds = new Set<string>();
  if (candidateMemoryIds.length > 0) {
    const { data: ownedTraceMemories, error: ownedMemoriesError } = await supabase
      .from("agent_memories")
      .select("id, workspace_id, metadata")
      .in("id", candidateMemoryIds)
      .eq("workspace_id", trace.workspace_id)
      .eq("metadata->>authenticated_agent_id", agent.agentId);
    if (ownedMemoriesError) return serverError(c, ownedMemoriesError);
    traceMemoryIds = new Set((ownedTraceMemories || [])
      .filter((memory) => ownsPersonalMemory(agent, memory.workspace_id, memory.metadata))
      .map((memory) => memory.id));
  }
  const reportedMemoryIds = new Set([
    ...parsed.data.used_memory_ids,
    ...parsed.data.ignored.map((item) => item.memory_id),
  ]);
  if ([...reportedMemoryIds].some((memoryId) => !traceMemoryIds.has(memoryId))) {
    return c.json({ error: "Usage can only be reported for memories in this Agent's recall trace" }, 400, corsHeaders);
  }

  for (const memory_id of parsed.data.used_memory_ids) {
    await supabase.from("agent_memory_recall_items").update({ used: true }).eq("trace_id", trace.id).eq("memory_id", memory_id);
    await audit("memory_used", { workspace_id: trace.workspace_id, project_id: trace.project_id, trace_id: trace.id, memory_id, runtime_name: trace.runtime_name, task_id: trace.task_id });
  }
  for (const ignored of parsed.data.ignored) {
    await supabase.from("agent_memory_recall_items").update({ used: false, ignored_reason: ignored.reason ?? null }).eq("trace_id", trace.id).eq("memory_id", ignored.memory_id);
    await audit("memory_ignored", { workspace_id: trace.workspace_id, project_id: trace.project_id, trace_id: trace.id, memory_id: ignored.memory_id, reason: ignored.reason });
  }

  return c.json({ ok: true }, 200, corsHeaders);
});

app.get("/memories/review", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) return c.json({ error: "workspace_id is required" }, 400, corsHeaders);
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  if (!isWorkspaceAllowed(agent.workspaceIds, workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }
  const project_id = c.req.query("project_id");
  let q = supabase.from("agent_memories").select("*").eq("workspace_id", workspace_id).eq("metadata->>authenticated_agent_id", agent.agentId).eq("review_status", "pending").order("created_at", { ascending: false }).limit(100);
  if (project_id) q = q.eq("project_id", project_id);
  const { data, error } = await q;
  if (error) return serverError(c, error);
  const memories = ((data || []) as AgentMemory[])
    .filter((memory) => ownsPersonalMemory(agent, memory.workspace_id, memory.metadata))
    .map(responseMemory);
  return c.json({ memories }, 200, corsHeaders);
});

app.get("/memories", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) return c.json({ error: "workspace_id is required" }, 400, corsHeaders);
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  if (!isWorkspaceAllowed(agent.workspaceIds, workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10), 1), 200);
  let q = supabase
    .from("agent_memories")
    .select("*")
    .eq("workspace_id", workspace_id)
    .eq("metadata->>authenticated_agent_id", agent.agentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  const project_id = c.req.query("project_id");
  const review_status = c.req.query("review_status");
  const lifecycle_status = c.req.query("lifecycle_status");
  const runtime_name = c.req.query("runtime_name");
  const memory_type = c.req.query("memory_type");
  const task_id_prefix = c.req.query("task_id_prefix");

  if (project_id) q = q.eq("project_id", project_id);
  if (review_status) q = q.eq("review_status", review_status);
  if (lifecycle_status) q = q.eq("lifecycle_status", lifecycle_status);
  if (runtime_name) q = q.eq("runtime_name", runtime_name);
  if (memory_type) q = q.eq("memory_type", memory_type);
  if (task_id_prefix) q = q.like("task_id", `${task_id_prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);

  const { data, error } = await q;
  if (error) return serverError(c, error);
  const memories = ((data || []) as AgentMemory[])
    .filter((memory) => ownsPersonalMemory(agent, memory.workspace_id, memory.metadata))
    .map(responseMemory);
  return c.json({ memories, count: memories.length }, 200, corsHeaders);
});

app.get("/shared-memories", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) return c.json({ error: "workspace_id is required" }, 400, corsHeaders);
  if (!isWorkspaceAllowed(c.get("workspaceIds"), workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }

  const project_id = c.req.query("project_id");
  const requestedScope = c.req.query("sharing_scope") || (project_id ? "project" : "workspace");
  const scope = z.enum(["project", "workspace", "organization"]).safeParse(requestedScope);
  if (!scope.success) return c.json({ error: "Invalid sharing_scope" }, 400, corsHeaders);
  if (scope.data === "project" && !project_id) {
    return c.json({ error: "project_id is required for project-scoped shared memories" }, 400, corsHeaders);
  }
  if (scope.data !== "project" && project_id) {
    return c.json({ error: "project_id must be omitted for workspace- or organization-scoped shared memories" }, 400, corsHeaders);
  }

  const rawIncludeUnconfirmed = c.req.query("include_unconfirmed");
  if (rawIncludeUnconfirmed !== undefined && !["true", "false"].includes(rawIncludeUnconfirmed)) {
    return c.json({ error: "include_unconfirmed must be true or false" }, 400, corsHeaders);
  }
  const includeUnconfirmed = rawIncludeUnconfirmed === "true";
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return c.json({ error: "limit must be an integer from 1 to 100" }, 400, corsHeaders);
  }

  let query = supabase
    .from("shared_agent_memories")
    .select("id, workspace_id, project_id, sharing_scope, memory_type, summary, content, lifecycle_status, provenance_status, confidence, created_by_agent, can_use_as_instruction, can_use_as_evidence, requires_user_confirmation, review_status, created_at, updated_at")
    .eq("workspace_id", workspace_id)
    .eq("sharing_scope", scope.data)
    .eq("lifecycle_status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (scope.data === "project") query = query.eq("project_id", project_id!);
  else query = query.is("project_id", null);
  if (includeUnconfirmed) query = query.in("review_status", ["pending", "confirmed", "evidence_only"]);
  else query = query.in("review_status", ["confirmed", "evidence_only"]);

  const { data, error } = await query;
  if (error) return serverError(c, error);
  const memories = (data || []).map((memory) => responseSharedMemory(memory as Record<string, unknown>));
  return c.json({ memories, count: memories.length }, 200, corsHeaders);
});

app.post("/shared-memories", async (c) => {
  const parsed = sharedMemorySchema.strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid shared-memory payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  if (!isWorkspaceAllowed(c.get("workspaceIds"), req.workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }
  if (req.sharing_scope === "project" && !req.project_id) {
    return c.json({ error: "project_id is required for project-scoped shared memories" }, 400, corsHeaders);
  }
  if (req.sharing_scope !== "project" && req.project_id) {
    return c.json({ error: "project_id must be omitted for workspace- or organization-scoped shared memories" }, 400, corsHeaders);
  }
  if (req.sharing_scope === "organization" && !hasCapability({ capabilities: c.get("capabilities") }, "shared:approve")) {
    return c.json({ error: "organization-scoped shared writes require the shared:approve capability" }, 403, corsHeaders);
  }

  const unsafe = [...unsafeReasons(req.summary), ...unsafeReasons(req.content)];
  if (unsafe.length > 0) return c.json({ error: "Unsafe shared-memory write blocked", reasons: [...new Set(unsafe)] }, 422, corsHeaders);

  const agentId = c.get("agentId");
  const idempotencyKey = req.idempotency_key ? `${agentId}:${req.idempotency_key}` : null;
  if (idempotencyKey) {
    const { data: existing, error: existingError } = await supabase
      .from("shared_agent_memories")
      .select("*")
      .eq("created_by_agent", agentId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) return serverError(c, existingError);
    if (existing) return c.json({ memory: responseSharedMemory(existing), deduplicated: true }, 200, corsHeaders);
  }

  const { data: memory, error } = await supabase.from("shared_agent_memories").insert({
    workspace_id: req.workspace_id,
    project_id: req.project_id ?? null,
    sharing_scope: req.sharing_scope,
    memory_type: req.memory_type,
    summary: req.summary,
    content: req.content,
    provenance_status: req.provenance_status,
    confidence: req.confidence,
    created_by_agent: agentId,
    can_use_as_instruction: false,
    can_use_as_evidence: true,
    requires_user_confirmation: true,
    review_status: "pending",
    lifecycle_status: "active",
    idempotency_key: idempotencyKey,
    metadata: { source: "agent-memory-api", authenticated_agent_id: agentId },
  }).select("*").single();
  if (error) {
    if (idempotencyKey && error.code === "23505") {
      const { data: existingAfterConflict, error: lookupError } = await supabase
        .from("shared_agent_memories")
        .select("*")
        .eq("created_by_agent", agentId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (!lookupError && existingAfterConflict) {
        return c.json({ memory: responseSharedMemory(existingAfterConflict), deduplicated: true }, 200, corsHeaders);
      }
    }
    return serverError(c, error);
  }

  await audit("memory_written", {
    workspace_id: req.workspace_id,
    project_id: req.project_id,
    actor_kind: "agent",
    actor_label: agentId,
    shared_memory_id: memory.id,
    sharing_scope: req.sharing_scope,
    memory_type: req.memory_type,
  });
  return c.json({ memory: responseSharedMemory(memory), deduplicated: false }, 201, corsHeaders);
});

app.post("/shared-memories/:id/approve", async (c) => {
  if (!hasCapability({ capabilities: c.get("capabilities") }, "shared:approve")) {
    return c.json({ error: "shared:approve capability required" }, 403, corsHeaders);
  }
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Shared memory not found" }, 404, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    review_status: z.enum(["confirmed", "evidence_only"]).default("confirmed"),
    notes: z.string().max(1000).nullable().optional(),
  }).safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: "Invalid approve payload", details: parsed.error.flatten() }, 400, corsHeaders);

  const { data: before, error: beforeError } = await supabase.from("shared_agent_memories").select("*").eq("id", id).maybeSingle();
  if (beforeError) return serverError(c, beforeError);
  if (!before || !isWorkspaceAllowed(c.get("workspaceIds"), before.workspace_id)) {
    return c.json({ error: "Shared memory not found" }, 404, corsHeaders);
  }
  const agentId = c.get("agentId");
  const { data: after, error } = await supabase.from("shared_agent_memories").update({
    review_status: parsed.data.review_status,
    requires_user_confirmation: false,
    updated_at: new Date().toISOString(),
    metadata: { ...(before.metadata || {}), approved_by_agent: agentId, approved_at: new Date().toISOString(), approval_notes: parsed.data.notes ?? null },
  }).eq("id", id).eq("workspace_id", before.workspace_id).select("*").single();
  if (error) return serverError(c, error);
  await audit("memory_confirmed", {
    workspace_id: before.workspace_id, project_id: before.project_id, actor_kind: "agent",
    actor_label: agentId, shared_memory_id: id, review_status: parsed.data.review_status,
  });
  return c.json({ memory: responseSharedMemory(after) }, 200, corsHeaders);
});

// Future: read access to the user's thoughts. Disabled unless a key carries thoughts:read (none do today).
app.post("/thoughts/search", async (c) => {
  if (!hasCapability({ capabilities: c.get("capabilities") }, "thoughts:read")) {
    return c.json({ error: "thoughts:read capability required" }, 403, corsHeaders);
  }
  const parsed = z.object({ query: z.string().min(1).max(4000), limit: z.number().int().min(1).max(25).default(10) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid search payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const embedding = await getEmbedding(parsed.data.query);
  const { data, error } = await supabase.rpc("match_thoughts", { query_embedding: embedding, match_threshold: 0.5, match_count: parsed.data.limit, filter: {} });
  if (error) return serverError(c, error);
  return c.json({ thoughts: data || [] }, 200, corsHeaders);
});

app.get("/memories/:id", async (c) => {
  const id = c.req.param("id");
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  const { data, error } = await supabase
    .from("agent_memories")
    .select("*, agent_memory_source_refs(*), agent_memory_artifacts(*)")
    .eq("id", id)
    .eq("metadata->>authenticated_agent_id", agent.agentId)
    .maybeSingle();
  if (error || !data || !ownsPersonalMemory(agent, data.workspace_id, data.metadata)) {
    return c.json({ error: "Memory not found" }, 404, corsHeaders);
  }
  return c.json({ memory: data }, 200, corsHeaders);
});

app.patch("/memories/:id/review", async (c) => {
  const id = c.req.param("id");
  const parsed = reviewSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid review payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  if (!["reject", "mark_stale", "dispute", "supersede"].includes(req.action)) {
    return c.json({ error: "Agent credentials cannot perform this review action; use user review for confirmation, evidence promotion, edits, and scope changes" }, 403, corsHeaders);
  }
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };

  const { data: before, error: beforeError } = await supabase
    .from("agent_memories")
    .select("*")
    .eq("id", id)
    .eq("metadata->>authenticated_agent_id", agent.agentId)
    .maybeSingle();
  if (beforeError || !before || !ownsPersonalMemory(agent, before.workspace_id, before.metadata)) {
    return c.json({ error: "Memory not found" }, 404, corsHeaders);
  }

  const updates: Record<string, unknown> = {};
  if (req.action === "supersede") {
    if (!req.related_memory_id || req.related_memory_id === id) {
      return c.json({ error: "supersede requires related_memory_id (the newer memory)" }, 400, corsHeaders);
    }
    const { data: newer } = await supabase.from("agent_memories").select("id, workspace_id, metadata")
      .eq("id", req.related_memory_id).eq("metadata->>authenticated_agent_id", agent.agentId).maybeSingle();
    if (!newer || !ownsPersonalMemory(agent, newer.workspace_id, newer.metadata) || newer.workspace_id !== before.workspace_id) {
      return c.json({ error: "related_memory_id not found" }, 404, corsHeaders);
    }
    updates.lifecycle_status = "superseded";
    updates.can_use_as_instruction = false;
  } else if (req.action === "reject") {
    updates.review_status = "rejected";
    updates.lifecycle_status = "rejected";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = false;
  } else if (req.action === "mark_stale") {
    updates.review_status = "stale";
    updates.lifecycle_status = "stale";
    updates.can_use_as_instruction = false;
  } else if (req.action === "dispute") {
    updates.lifecycle_status = "disputed";
    updates.provenance_status = "disputed";
    updates.can_use_as_instruction = false;
  }

  const { data: after, error: updateError } = await supabase
    .from("agent_memories")
    .update(updates)
    .eq("id", id)
    .eq("workspace_id", before.workspace_id)
    .eq("metadata->>authenticated_agent_id", agent.agentId)
    .select("*")
    .single();
  if (updateError) return serverError(c, updateError);

  await supabase.from("agent_memory_review_actions").insert({
    memory_id: id,
    action: req.action,
    actor_id: agent.agentId,
    actor_label: agent.agentId,
    notes: req.notes ?? null,
    before,
    after,
  });

  if (req.action === "supersede") {
    await supabase.from("agent_memory_relations").upsert([
      { from_memory_id: req.related_memory_id, to_memory_id: id, relation: "supersedes" },
      { from_memory_id: id, to_memory_id: req.related_memory_id, relation: "superseded_by" },
    ], { onConflict: "from_memory_id,to_memory_id,relation", ignoreDuplicates: true });
  }

  const eventMap: Record<string, string> = {
    supersede: "memory_superseded",
    reject: "memory_rejected",
    dispute: "memory_disputed",
  };
  await audit(eventMap[req.action] || "memory_edited", {
    workspace_id: before.workspace_id,
    project_id: before.project_id,
    memory_id: id,
    actor_kind: "agent",
    actor_label: agent.agentId,
    action: req.action,
  });

  return c.json({ memory: after }, 200, corsHeaders);
});

// Forget: hard-delete one of this Agent's own memories (cascades refs/artifacts/relations/recall items).
app.delete("/memories/:id", async (c) => {
  const id = c.req.param("id");
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  const { data: before } = await supabase.from("agent_memories").select("id, workspace_id, project_id, metadata")
    .eq("id", id).eq("metadata->>authenticated_agent_id", agent.agentId).maybeSingle();
  if (!before || !ownsPersonalMemory(agent, before.workspace_id, before.metadata)) {
    return c.json({ error: "Memory not found" }, 404, corsHeaders);
  }
  const { error } = await supabase.from("agent_memories").delete()
    .eq("id", id).eq("metadata->>authenticated_agent_id", agent.agentId);
  if (error) return serverError(c, error);
  await audit("memory_rejected", {
    workspace_id: before.workspace_id, project_id: before.project_id, actor_kind: "agent",
    actor_label: agent.agentId, action: "forget", forgotten_memory_id: id,
  });
  return c.json({ ok: true, forgotten: id }, 200, corsHeaders);
});

app.post("/locks/acquire", async (c) => {
  const parsed = lockSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid lock payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  if (!isWorkspaceAllowed(c.get("workspaceIds"), req.workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }
  const { data, error } = await supabase.rpc("agent_memory_acquire_lock", {
    p_workspace_id: req.workspace_id, p_lock_key: req.lock_key, p_agent_id: c.get("agentId"),
    p_ttl_seconds: req.ttl_seconds, p_note: req.note ?? null,
  });
  if (error) return serverError(c, error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.lock_key) {
    const { data: held } = await supabase.from("agent_memory_locks").select("holder_agent_id, expires_at")
      .eq("workspace_id", req.workspace_id).eq("lock_key", req.lock_key).maybeSingle();
    return c.json({ acquired: false, holder_agent_id: held?.holder_agent_id ?? null, expires_at: held?.expires_at ?? null }, 409, corsHeaders);
  }
  return c.json({ acquired: true, lock: row }, 200, corsHeaders);
});

app.post("/locks/release", async (c) => {
  const parsed = lockSchema.pick({ workspace_id: true, lock_key: true }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid lock payload", details: parsed.error.flatten() }, 400, corsHeaders);
  if (!isWorkspaceAllowed(c.get("workspaceIds"), parsed.data.workspace_id)) {
    return c.json({ error: "workspace_id is not authorized for this Agent" }, 403, corsHeaders);
  }
  const { data, error } = await supabase.from("agent_memory_locks").delete()
    .eq("workspace_id", parsed.data.workspace_id).eq("lock_key", parsed.data.lock_key)
    .eq("holder_agent_id", c.get("agentId")).select("lock_key");
  if (error) return serverError(c, error);
  return c.json({ released: (data || []).length > 0 }, 200, corsHeaders);
});

app.get("/recall-traces/:request_id", async (c) => {
  const request_id = c.req.param("request_id");
  const agent = { agentId: c.get("agentId"), workspaceIds: c.get("workspaceIds") };
  const { data: trace, error } = await supabase
    .from("agent_memory_recall_traces")
    .select("*")
    .eq("request_id", request_id)
    .eq("request_payload->>authenticated_agent_id", agent.agentId)
    .maybeSingle();
  if (error || !trace || !ownsRecallTrace(agent, trace)) {
    return c.json({ error: "Recall trace not found" }, 404, corsHeaders);
  }
  const { data: items, error: itemError } = await supabase.from("agent_memory_recall_items").select("*, agent_memories(*)").eq("trace_id", trace.id).order("rank");
  if (itemError) return serverError(c, itemError);
  const ownedItems = (items || []).filter((item) => {
    const memory = item.agent_memories as unknown as AgentMemory | null;
    return Boolean(memory && ownsPersonalMemory(agent, memory.workspace_id, memory.metadata));
  });
  return c.json({ trace, items: ownedItems }, 200, corsHeaders);
});

// --- Wellness routes (Honey only) ---

app.post("/wellness", async (c) => {
  const guard = requireWellnessAgent(c);
  if (guard) return guard;
  const parsed = wellnessInsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid wellness payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  const agentId = c.get("agentId");
  const { data, error } = await supabase.from("agent_wellness_log").insert({
    owner: agentId,
    kind: req.kind,
    ...(req.logged_at ? { logged_at: req.logged_at } : {}),
    energy: req.energy ?? null,
    hunger: req.hunger ?? null,
    alertness: req.alertness ?? null,
    food_text: req.food_text ?? null,
    food_size: req.food_size ?? null,
    caffeine: req.caffeine ?? null,
    alcohol: req.alcohol ?? null,
    note: req.note ?? null,
    source: req.source ?? null,
    tunnel_progress: req.tunnel_progress ?? null,
  }).select("*").single();
  if (error) return wellnessServerError(c, error);
  return c.json({ wellness: data }, 201, corsHeaders);
});

app.get("/wellness/summary", async (c) => {
  const guard = requireWellnessAgent(c);
  if (guard) return guard;
  const range = resolveWellnessRange(c);
  if (range instanceof Response) return range;
  const agentId = c.get("agentId");
  const startUTC = localMidnightUTC(range.from, TORONTO_TZ);
  const endUTC = localMidnightUTC(addDaysToDateStr(range.to, 1), TORONTO_TZ);
  const maxRows = 5000;
  const { data, error } = await fetchWellnessRows(agentId, startUTC.toISOString(), endUTC.toISOString(), maxRows);
  if (error) return wellnessServerError(c, error);
  const rows = data || [];
  return c.json({ ...summarizeWellness(rows, range.from, range.to), truncated: rows.length >= maxRows }, 200, corsHeaders);
});

app.get("/wellness", async (c) => {
  const guard = requireWellnessAgent(c);
  if (guard) return guard;
  const range = resolveWellnessRange(c);
  if (range instanceof Response) return range;

  const kind = c.req.query("kind");
  if (kind && !["check_in", "food", "missed"].includes(kind)) {
    return c.json({ error: "kind must be one of check_in, food, missed" }, 400, corsHeaders);
  }
  const limitQuery = c.req.query("limit");
  let limit = 500;
  if (limitQuery !== undefined) {
    const n = Number(limitQuery);
    if (!Number.isInteger(n) || n < 1 || n > 2000) return c.json({ error: "limit must be an integer from 1 to 2000" }, 400, corsHeaders);
    limit = n;
  }

  const agentId = c.get("agentId");
  const startUTC = localMidnightUTC(range.from, TORONTO_TZ);
  const endUTC = localMidnightUTC(addDaysToDateStr(range.to, 1), TORONTO_TZ);

  const { data, error } = await fetchWellnessRows(agentId, startUTC.toISOString(), endUTC.toISOString(), limit, kind);
  if (error) return wellnessServerError(c, error);
  const wellness = (data || []).map((row) => ({ ...row, local_time: localTimeLabel(new Date(row.logged_at), TORONTO_TZ) }));
  return c.json({ wellness, count: wellness.length, range: { from: range.from, to: range.to, time_zone: TORONTO_TZ } }, 200, corsHeaders);
});

app.patch("/wellness/:id", async (c) => {
  const guard = requireWellnessAgent(c);
  if (guard) return guard;
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Wellness entry not found" }, 404, corsHeaders);

  const rawBody = await c.req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return c.json({ error: "Invalid JSON body" }, 400, corsHeaders);
  if ((rawBody as Record<string, unknown>).logged_at === null) {
    return c.json({ error: "logged_at cannot be null" }, 400, corsHeaders);
  }
  if ((rawBody as Record<string, unknown>).kind === null) {
    return c.json({ error: "kind cannot be null" }, 400, corsHeaders);
  }
  const parsed = wellnessPatchSchema.safeParse(rawBody);
  if (!parsed.success) return c.json({ error: "Invalid wellness patch payload", details: parsed.error.flatten() }, 400, corsHeaders);
  if (parsed.data.confirm !== true) {
    return c.json({ error: "confirm=true required (only edit when Tyrone asks)" }, 400, corsHeaders);
  }

  const agentId = c.get("agentId");
  const { data: existing, error: existingError } = await supabase
    .from("agent_wellness_log")
    .select("*")
    .eq("id", id)
    .eq("owner", agentId)
    .maybeSingle();
  if (existingError) return wellnessServerError(c, existingError);
  if (!existing) return c.json({ error: "Wellness entry not found" }, 404, corsHeaders);

  const updateFields: Record<string, unknown> = {};
  for (const key of WELLNESS_FIELD_KEYS) {
    if (key in rawBody) updateFields[key] = (parsed.data as Record<string, unknown>)[key] ?? null;
  }

  const merged = { ...existing, ...updateFields } as WellnessFields;
  const ruleErrors = wellnessRuleErrors(merged);
  if (ruleErrors.length > 0) return c.json({ error: "Invalid wellness update", details: ruleErrors }, 400, corsHeaders);

  const { data: updated, error: updateError } = await supabase
    .from("agent_wellness_log")
    .update(updateFields)
    .eq("id", id)
    .eq("owner", agentId)
    .select("*")
    .single();
  if (updateError) return wellnessServerError(c, updateError);
  return c.json({ wellness: updated }, 200, corsHeaders);
});

app.delete("/wellness/:id", async (c) => {
  const guard = requireWellnessAgent(c);
  if (guard) return guard;
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Wellness entry not found" }, 404, corsHeaders);
  if (c.req.query("confirm") !== "true") {
    return c.json({ error: "confirm=true required (only edit when Tyrone asks)" }, 400, corsHeaders);
  }
  const agentId = c.get("agentId");
  const { data, error } = await supabase
    .from("agent_wellness_log")
    .delete()
    .eq("id", id)
    .eq("owner", agentId)
    .select("id")
    .maybeSingle();
  if (error) return wellnessServerError(c, error);
  if (!data) return c.json({ error: "Wellness entry not found" }, 404, corsHeaders);
  return c.json({ deleted: id }, 200, corsHeaders);
});

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/agent-memory-api") {
    url.pathname = "/";
  } else if (url.pathname.startsWith("/agent-memory-api/")) {
    url.pathname = url.pathname.slice("/agent-memory-api".length);
  }
  return app.fetch(new Request(url, req));
});
