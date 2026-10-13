#!/usr/bin/env node

const endpoint = requiredEnv("OB1_AGENT_MEMORY_ENDPOINT").replace(/\/$/, "");
const accessKey = requiredEnv("OB1_AGENT_MEMORY_KEY");

const workspaceId = process.env.OB1_AGENT_MEMORY_WORKSPACE_ID || "ob1-staging";
const projectId = process.env.OB1_AGENT_MEMORY_PROJECT_ID || "agent-memory-api-smoke";
const runId = process.env.OB1_AGENT_MEMORY_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const taskId = `agent-memory-api-smoke-${runId}`;

const summary = {
  run_id: runId,
  endpoint,
  workspace_id: workspaceId,
  project_id: projectId,
  checks: {},
};

async function main() {
  const anonymousHealth = await fetch(`${endpoint}/health`);
  assert(anonymousHealth.status === 401, `anonymous health check should return 401, got ${anonymousHealth.status}`);
  const legacyAuth = await fetch(`${endpoint}/health?key=legacy-test-key`, {
    headers: { "x-brain-key": "legacy-test-key" },
  });
  assert(legacyAuth.status === 401, `legacy shared-key auth should return 401, got ${legacyAuth.status}`);
  summary.checks.agent_authentication = "passed";

  const health = await request("/health");
  assert(health.ok === true, "health did not return ok=true");
  summary.checks.health = "passed";

  const sharedMemoryParams = new URLSearchParams({
    workspace_id: workspaceId,
    project_id: projectId,
    sharing_scope: "project",
    limit: "10",
  });
  const sharedMemoryList = await request(`/shared-memories?${sharedMemoryParams}`);
  assert(Array.isArray(sharedMemoryList.memories), "shared-memory list did not return a memories array");
  const invalidSharedScope = await request(`/shared-memories?${new URLSearchParams({
    workspace_id: workspaceId,
    sharing_scope: "project",
  })}`, { expectedStatus: 400 });
  assert(invalidSharedScope.error?.includes("project_id"), "project-scoped shared-memory read did not require project_id");
  summary.checks.shared_memory_scope = { status: "passed", returned_count: sharedMemoryList.count };

  const writeback = await request("/writeback", {
    method: "POST",
    body: writebackPayload(),
  });
  const writtenIds = (writeback.memories || []).map((memory) => memory.memory_id);
  assert(writtenIds.length >= 3, `expected at least 3 written memories, got ${writtenIds.length}`);
  assert(writeback.memories.every((memory) => memory.provenance?.status === "generated"), "Agent forged imported or user-confirmed provenance");
  assert(writeback.memories.every((memory) => memory.use_policy?.can_use_as_instruction === false), "generated writeback became instruction-grade");
  assert(writeback.memories.every((memory) => memory.use_policy?.can_use_as_evidence === true), "generated writeback was not evidence-enabled");
  assert(writeback.memories.every((memory) => memory.use_policy?.requires_user_confirmation === true), "generated writeback did not require review");
  summary.checks.writeback = { status: "passed", memory_count: writtenIds.length };

  const listed = await request(`/memories?${new URLSearchParams({
    workspace_id: workspaceId,
    project_id: projectId,
    task_id_prefix: taskId,
    limit: "20",
  })}`);
  assert(listed.count >= writtenIds.length, "memory list endpoint did not return newly written smoke memories");
  summary.checks.memory_list = { status: "passed", returned_count: listed.count };

  const conservativeRecall = await request("/recall", {
    method: "POST",
    body: recallPayload(false),
  });
  const conservativeIds = new Set((conservativeRecall.memories || []).map((memory) => memory.memory_id));
  assert(writtenIds.every((id) => !conservativeIds.has(id)), "pending generated memory appeared in conservative recall");
  summary.checks.conservative_recall_gate = {
    status: "passed",
    returned_count: conservativeRecall.memories?.length || 0,
  };

  const inclusiveRecall = await request("/recall", {
    method: "POST",
    body: recallPayload(true),
  });
  const recalledIds = (inclusiveRecall.memories || []).map((memory) => memory.memory_id);
  const recalledWrittenId = writtenIds.find((id) => recalledIds.includes(id));
  assert(recalledWrittenId, "include_unconfirmed recall did not return any newly written memory");
  summary.checks.include_unconfirmed_recall = {
    status: "passed",
    request_id: inclusiveRecall.request_id,
    returned_count: recalledIds.length,
    used_memory_id: recalledWrittenId,
  };

  await request(`/recall/${inclusiveRecall.request_id}/usage`, {
    method: "POST",
    body: {
      used_memory_ids: [recalledWrittenId],
      ignored: recalledIds.filter((id) => id !== recalledWrittenId).slice(0, 2).map((memory_id) => ({
        memory_id,
        reason: "not needed for live API smoke assertion",
      })),
    },
  });
  summary.checks.usage_reporting = "passed";

  const deniedReview = await request(`/memories/${writtenIds[0]}/review`, {
    method: "PATCH",
    body: {
      action: "confirm",
      actor_label: "OB1 Agent Memory API live smoke",
      notes: `API smoke run ${runId}`,
    },
    expectedStatus: 403,
  });
  assert(deniedReview.error?.includes("user review"), "Agent credential was not denied user review action");
  const reviewState = await request(`/memories/${writtenIds[0]}`);
  assert(reviewState.memory?.review_status === "pending", "Agent review denial changed the pending review state");
  assert(reviewState.memory?.can_use_as_instruction === false, "Agent review denial made memory instruction-grade");
  assert(reviewState.memory?.requires_user_confirmation === true, "Agent review denial removed user confirmation requirement");
  summary.checks.agent_review_restriction = {
    status: "passed",
    denied_action: "confirm",
    review_status_after: reviewState.memory.review_status,
  };

  const inspected = await request(`/memories/${writtenIds[0]}`);
  assert(inspected.memory?.id === writtenIds[0], "inspect returned the wrong memory");
  summary.checks.inspect_memory = "passed";

  const trace = await request(`/recall-traces/${inclusiveRecall.request_id}`);
  assert(trace.items?.some((item) => item.memory_id === recalledWrittenId && item.used === true), "recall trace did not mark used memory");
  summary.checks.recall_trace = {
    status: "passed",
    trace_item_count: trace.items?.length || 0,
  };

  const unsafe = await request("/writeback", {
    method: "POST",
    body: unsafeWritebackPayload(),
    expectedStatus: 422,
  });
  assert(unsafe.error === "Unsafe write-back blocked", "unsafe writeback was not blocked");
  summary.checks.unsafe_writeback_block = "passed";

  console.log(JSON.stringify({
    ok: true,
    ...summary,
  }, null, 2));
}

function writebackPayload() {
  return {
    schema_version: "openbrain.openclaw.writeback.v1",
    workspace_id: workspaceId,
    project_id: projectId,
    task_id: taskId,
    step_id: "writeback-1",
    idempotency_key: `${taskId}:writeback-1`,
    channel: { kind: "cli", id: "api-smoke", thread_id: runId },
    runtime: { name: "smoke-harness", version: "0.1.0" },
    models_used: [{ provider: "harness", model: "direct-api", role: "smoke" }],
    source_refs: [{
      kind: "repo",
      uri: "repo://integrations/agent-memory-api/smoke/live-smoke.mjs",
      title: "Agent Memory API live smoke harness",
    }],
    memory_payload: {
      decisions: [],
      outputs: [`OB1 Agent Memory API live smoke ${runId} wrote governed memory through the live endpoint.`],
      lessons: [`Live API smoke ${runId} verifies generated memory remains evidence-only until review.`],
      constraints: ["Smoke harnesses must never print OB1 Agent Memory access keys."],
      unresolved_questions: [],
      next_steps: ["Keep this smoke harness in the release checklist before OpenClaw/ClawHub publishing."],
      failures: [],
      artifacts: [{
        kind: "script",
        uri: "repo://integrations/agent-memory-api/smoke/live-smoke.mjs",
        description: "Repeatable API smoke harness",
      }],
      entities: {
        topics: ["OB1 Agent Memory", "smoke test", "writeback", "recall trace"],
        repos: ["OB1"],
      },
    },
    provenance: { default_status: "imported", confidence: 0.83, requires_review: false },
    retention: { stale_after_days: 30 },
    visibility: { workspace: "private", project: "project", channel: "cli" },
  };
}

function recallPayload(includeUnconfirmed) {
  return {
    schema_version: "openbrain.openclaw.recall.v1",
    workspace_id: workspaceId,
    project_id: projectId,
    task_id: taskId,
    task_type: "smoke",
    channel: { kind: "cli", id: "api-smoke", thread_id: runId },
    runtime: { name: "smoke-harness", version: "0.1.0" },
    model_intent: { provider: "harness", model: "direct-api" },
    query: `OB1 Agent Memory API live smoke ${runId} governed memory evidence-only recall trace`,
    entities: { topics: ["OB1 Agent Memory", "smoke test"], repos: ["OB1"] },
    scope: {
      visibility: "project",
      project_only: true,
      include_unconfirmed: includeUnconfirmed,
      include_stale: false,
    },
    limits: { max_items: 10, max_tokens: 4000, recency_days: 7 },
    sensitivity: { contains_code: false, contains_customer_data: false, contains_private_meeting_data: false },
  };
}

function unsafeWritebackPayload() {
  return {
    ...writebackPayload(),
    task_id: `${taskId}-unsafe`,
    step_id: "unsafe-writeback",
    idempotency_key: `${taskId}:unsafe-writeback`,
    memory_payload: {
      ...writebackPayload().memory_payload,
      outputs: ["This fake unsafe payload contains api_key: sk-or-v1-0000000000000000000000000000000000000000"],
      lessons: [],
      constraints: [],
      next_steps: [],
      artifacts: [],
    },
  };
}

async function request(path, options = {}) {
  const expectedStatus = options.expectedStatus || 200;
  const response = await fetch(`${endpoint}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessKey}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (response.status !== expectedStatus) {
    fail(`Expected ${expectedStatus} from ${path}, got ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`Set ${name}.`);
  return value;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

main().catch((error) => fail(error?.message || String(error)));
