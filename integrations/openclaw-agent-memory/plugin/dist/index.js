// src/index.ts
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

// src/client.ts
function requestInput(input) {
  return input && typeof input === "object" ? input : {};
}
function projectIdFrom(input, configuredProjectId) {
  if (configuredProjectId) return configuredProjectId;
  if (typeof input.project_id === "string" || input.project_id === null) return input.project_id;
  return null;
}
var AgentMemoryClient = class {
  constructor(config) {
    this.config = config;
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.accessKey = config.accessKey;
    if (!this.accessKey) {
      throw new Error("OB1 Agent Memory access key missing. Configure plugins.entries.nbj-ob1-agent-memory.config.accessKey.");
    }
  }
  endpoint;
  accessKey;
  async request(path, options = {}) {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessKey}`
      },
      body: options.body === void 0 ? void 0 : JSON.stringify(options.body)
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`OB1 Agent Memory API ${response.status}: ${data.error || text}`);
    }
    return data;
  }
  recall(input) {
    const request = requestInput(input);
    const projectId = projectIdFrom(request, this.config.projectId);
    return this.request("/recall", {
      method: "POST",
      body: {
        ...request,
        schema_version: "openbrain.openclaw.recall.v1",
        workspace_id: this.config.workspaceId,
        project_id: projectId,
        scope: {
          include_unconfirmed: this.config.includeUnconfirmedRecall ?? false,
          ...typeof request.scope === "object" && request.scope ? request.scope : {}
        }
      }
    });
  }
  writeback(input) {
    const request = requestInput(input);
    const projectId = projectIdFrom(request, this.config.projectId);
    return this.request("/writeback", {
      method: "POST",
      body: {
        ...request,
        schema_version: "openbrain.openclaw.writeback.v1",
        workspace_id: this.config.workspaceId,
        project_id: projectId,
        provenance: {
          default_status: "generated",
          confidence: 0.5,
          requires_review: this.config.requireReviewByDefault ?? true,
          ...typeof request.provenance === "object" && request.provenance ? request.provenance : {}
        }
      }
    });
  }
  reportUsage(requestId, input) {
    return this.request(`/recall/${requestId}/usage`, { method: "POST", body: input });
  }
  inspectMemory(memoryId) {
    return this.request(`/memories/${memoryId}`);
  }
  listReviewQueue(input = {}) {
    const workspaceId = input.workspace_id || this.config.workspaceId;
    const projectId = input.project_id || this.config.projectId;
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (projectId) params.set("project_id", projectId);
    return this.request(`/memories/review?${params.toString()}`);
  }
  reviewMemory(memoryId, input) {
    return this.request(`/memories/${memoryId}/review`, { method: "PATCH", body: input });
  }
  getRecallTrace(requestId) {
    return this.request(`/recall-traces/${requestId}`);
  }
};

// src/index.ts
async function clientFromApi(api) {
  const raw = api.pluginConfig || {};
  if (typeof raw.endpoint !== "string" || raw.endpoint.length === 0) {
    throw new Error("OB1 Agent Memory plugin requires config.endpoint");
  }
  if (typeof raw.workspaceId !== "string" || raw.workspaceId.length === 0) {
    throw new Error("OB1 Agent Memory plugin requires config.workspaceId");
  }
  const accessKey = await resolveConfiguredSecretInputString({
    config: api.config || {},
    env: {},
    value: raw.accessKey,
    path: "plugins.entries.nbj-ob1-agent-memory.config.accessKey",
    unresolvedReasonStyle: "detailed"
  });
  if (!accessKey.value) {
    const reason = accessKey.unresolvedRefReason ? ` ${accessKey.unresolvedRefReason}` : "";
    throw new Error(`OB1 Agent Memory plugin requires config.accessKey.${reason}`);
  }
  const config = {
    endpoint: raw.endpoint,
    accessKey: accessKey.value,
    workspaceId: raw.workspaceId,
    projectId: typeof raw.projectId === "string" ? raw.projectId : void 0,
    requireReviewByDefault: typeof raw.requireReviewByDefault === "boolean" ? raw.requireReviewByDefault : true,
    includeUnconfirmedRecall: typeof raw.includeUnconfirmedRecall === "boolean" ? raw.includeUnconfirmedRecall : false
  };
  return new AgentMemoryClient(config);
}
function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    details: value
  };
}
var nullableString = Type.Union([Type.String(), Type.Literal(null)]);
var optionalNullableString = Type.Optional(nullableString);
var stringArrayRecord = Type.Record(Type.String(), Type.Array(Type.String()));
var channelParameters = Type.Object({
  kind: optionalNullableString,
  id: optionalNullableString,
  thread_id: optionalNullableString
});
var runtimeParameters = Type.Object({
  name: Type.Optional(Type.String()),
  version: optionalNullableString
});
var modelIntentParameters = Type.Object({
  provider: optionalNullableString,
  model: optionalNullableString
});
var recallParameters = Type.Object({
  schema_version: Type.Optional(Type.Union([
    Type.Literal("openbrain.agent_memory.recall.v1"),
    Type.Literal("openbrain.openclaw.recall.v1")
  ])),
  workspace_id: Type.Optional(Type.String()),
  project_id: optionalNullableString,
  task_id: optionalNullableString,
  flow_id: optionalNullableString,
  task_type: optionalNullableString,
  channel: Type.Optional(channelParameters),
  runtime: Type.Optional(runtimeParameters),
  model_intent: Type.Optional(modelIntentParameters),
  query: Type.String(),
  entities: Type.Optional(stringArrayRecord),
  scope: Type.Optional(Type.Object({
    visibility: optionalNullableString,
    project_only: Type.Optional(Type.Boolean()),
    include_unconfirmed: Type.Optional(Type.Boolean()),
    include_stale: Type.Optional(Type.Boolean())
  })),
  limits: Type.Optional(Type.Object({
    max_items: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    max_tokens: Type.Optional(Type.Number({ minimum: 256, maximum: 2e4 })),
    recency_days: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Literal(null)]))
  })),
  sensitivity: Type.Optional(Type.Record(Type.String(), Type.Boolean()))
});
var memoryPayloadParameters = Type.Object({
  decisions: Type.Optional(Type.Array(Type.String())),
  outputs: Type.Optional(Type.Array(Type.String())),
  lessons: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
  unresolved_questions: Type.Optional(Type.Array(Type.String())),
  next_steps: Type.Optional(Type.Array(Type.String())),
  failures: Type.Optional(Type.Array(Type.String())),
  artifacts: Type.Optional(Type.Array(Type.Object({
    kind: Type.String(),
    uri: Type.String(),
    description: optionalNullableString
  }))),
  entities: Type.Optional(stringArrayRecord)
});
var writebackParameters = Type.Object({
  schema_version: Type.Optional(Type.Union([
    Type.Literal("openbrain.agent_memory.writeback.v1"),
    Type.Literal("openbrain.openclaw.writeback.v1")
  ])),
  workspace_id: Type.Optional(Type.String()),
  project_id: optionalNullableString,
  task_id: optionalNullableString,
  flow_id: optionalNullableString,
  step_id: optionalNullableString,
  idempotency_key: optionalNullableString,
  content_hash: optionalNullableString,
  channel: Type.Optional(channelParameters),
  runtime: Type.Optional(runtimeParameters),
  models_used: Type.Optional(Type.Array(Type.Object({
    provider: Type.String(),
    model: Type.String(),
    role: Type.String()
  }))),
  source_refs: Type.Optional(Type.Array(Type.Object({
    kind: Type.String(),
    uri: optionalNullableString,
    title: optionalNullableString,
    timestamp: optionalNullableString
  }))),
  memory_payload: memoryPayloadParameters,
  provenance: Type.Optional(Type.Object({
    default_status: Type.Optional(Type.Union([
      Type.Literal("observed"),
      Type.Literal("inferred"),
      Type.Literal("user_confirmed"),
      Type.Literal("imported"),
      Type.Literal("generated")
    ])),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    requires_review: Type.Optional(Type.Boolean())
  })),
  retention: Type.Optional(Type.Object({
    ttl_days: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Literal(null)])),
    stale_after_days: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Literal(null)]))
  })),
  visibility: Type.Optional(Type.Object({
    workspace: optionalNullableString,
    project: optionalNullableString,
    channel: optionalNullableString
  }))
});
function registerTool(api, tool) {
  api.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params) {
      const result = await tool.run(await clientFromApi(api), params);
      return toolResult(result);
    }
  });
}
var index_default = definePluginEntry({
  id: "nbj-ob1-agent-memory",
  name: "NBJ OB1 Agent Memory for OpenClaw",
  description: "Recall and write governed Nate Jones OB1 memory from OpenClaw workflows.",
  kind: "memory",
  register(api) {
    registerTool(api, {
      name: "openbrain_recall",
      label: "NBJ OB1 recall",
      description: "Recall scoped Nate Jones OB1 Agent Memory before meaningful work begins.",
      parameters: recallParameters,
      run: (client, input) => client.recall(input)
    });
    registerTool(api, {
      name: "openbrain_writeback",
      label: "NBJ OB1 write-back",
      description: "Write compact, provenance-labeled Nate Jones OB1 Agent Memory after work finishes.",
      parameters: writebackParameters,
      run: (client, input) => client.writeback(input)
    });
    registerTool(api, {
      name: "openbrain_report_usage",
      label: "NBJ OB1 report usage",
      description: "Report which recalled memories were used or ignored.",
      parameters: Type.Object({
        request_id: Type.String(),
        used_memory_ids: Type.Optional(Type.Array(Type.String())),
        ignored: Type.Optional(Type.Array(Type.Object({
          memory_id: Type.String(),
          reason: Type.Optional(Type.String())
        })))
      }),
      run: (client, input) => client.reportUsage(input.request_id, {
        used_memory_ids: input.used_memory_ids || [],
        ignored: input.ignored || []
      })
    });
    registerTool(api, {
      name: "openbrain_inspect_memory",
      label: "NBJ OB1 inspect memory",
      description: "Inspect one Nate Jones OB1 Agent Memory record, including provenance and source references.",
      parameters: Type.Object({ memory_id: Type.String() }),
      run: (client, input) => client.inspectMemory(input.memory_id)
    });
    registerTool(api, {
      name: "openbrain_list_review_queue",
      label: "NBJ OB1 review queue",
      description: "List agent-written memories pending human review.",
      parameters: Type.Object({
        workspace_id: Type.Optional(Type.String()),
        project_id: Type.Optional(Type.String())
      }),
      run: (client, input) => client.listReviewQueue(input)
    });
    registerTool(api, {
      name: "openbrain_review_memory",
      label: "NBJ OB1 review memory",
      description: "Confirm, edit, evidence-only, restrict, stale, dispute, supersede, or reject a memory.",
      parameters: Type.Object({
        memory_id: Type.String(),
        action: Type.Union([
          Type.Literal("confirm"),
          Type.Literal("edit"),
          Type.Literal("evidence_only"),
          Type.Literal("restrict_scope"),
          Type.Literal("mark_stale"),
          Type.Literal("merge"),
          Type.Literal("reject"),
          Type.Literal("dispute"),
          Type.Literal("supersede")
        ]),
        actor_id: Type.Optional(Type.String()),
        actor_label: Type.Optional(Type.String()),
        notes: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        visibility: Type.Optional(Type.String()),
        related_memory_id: Type.Optional(Type.String())
      }),
      run: (client, input) => {
        const { memory_id, ...body } = input;
        return client.reviewMemory(memory_id, body);
      }
    });
    registerTool(api, {
      name: "openbrain_get_recall_trace",
      label: "NBJ OB1 recall trace",
      description: "Fetch a recall trace to debug which memories were returned and used.",
      parameters: Type.Object({ request_id: Type.String() }),
      run: (client, input) => client.getRecallTrace(input.request_id)
    });
    const OB1_TOOL_NAMES = [
      "openbrain_recall",
      "openbrain_writeback",
      "openbrain_report_usage",
      "openbrain_inspect_memory",
      "openbrain_list_review_queue",
      "openbrain_review_memory",
      "openbrain_get_recall_trace"
    ];
    function isConfigured() {
      const raw = api.pluginConfig || {};
      return typeof raw.endpoint === "string" && raw.endpoint.length > 0 && typeof raw.workspaceId === "string" && raw.workspaceId.length > 0;
    }
    if (typeof api.registerMemoryPromptSupplement === "function") {
      api.registerMemoryPromptSupplement((params) => {
        if (!isConfigured()) return [];
        const present = OB1_TOOL_NAMES.filter((t) => params.availableTools.has(t));
        if (present.length === 0) return [];
        return [
          "## OB1 Agent Memory",
          "Long-term governed memory is available via OB1. Use it as a discipline, not a fallback.",
          "",
          "Workflow:",
          "- Before meaningful work, call `openbrain_recall` with a task-scoped query.",
          "- Treat returned memories tagged `instruction` as binding rules; `evidence`-tagged ones as supporting context only.",
          "- After meaningful work, call `openbrain_writeback` with compact, provenance-labeled findings (decisions, lessons, constraints, outputs, failures).",
          "- After acting on recalled memories, call `openbrain_report_usage` with `request_id` and the IDs you used vs. ignored \u2014 closes the recall-quality loop.",
          "",
          `Available tools: ${present.map((t) => "`" + t + "`").join(", ")}.`
        ];
      });
    }
    if (typeof api.registerMemoryCorpusSupplement === "function") {
      api.registerMemoryCorpusSupplement({
        async search(input) {
          if (!isConfigured()) return [];
          let client;
          try {
            client = await clientFromApi(api);
          } catch {
            return [];
          }
          const limit = Math.min(Math.max(input.maxResults ?? 10, 1), 50);
          let response;
          try {
            response = await client.recall({
              query: input.query.slice(0, 2e3),
              task_type: "general",
              limits: { max_items: limit, max_tokens: 4e3 },
              scope: { project_only: false, include_unconfirmed: false, include_stale: false }
            });
          } catch {
            return [];
          }
          const memories = Array.isArray(response?.memories) ? response.memories : [];
          return memories.map((m, i) => {
            const policy = m?.use_policy ?? {};
            const provenance = policy?.can_use_as_instruction ? "instruction" : policy?.can_use_as_evidence ? "evidence" : void 0;
            return {
              corpus: "openbrain",
              path: `openbrain://memory/${m?.id ?? i}`,
              title: typeof m?.summary === "string" ? m.summary.slice(0, 80) : void 0,
              kind: "memory",
              score: typeof m?.score === "number" ? m.score : Math.max(0, 1 - i / Math.max(memories.length, 1)),
              snippet: String(m?.summary ?? m?.content ?? "").slice(0, 600),
              id: typeof m?.id === "string" ? m.id : void 0,
              provenanceLabel: provenance,
              source: "openbrain.agent_memory",
              sourceType: "openbrain.agent_memory",
              updatedAt: typeof m?.updated_at === "string" ? m.updated_at : void 0
            };
          });
        },
        async get(input) {
          if (!isConfigured()) return null;
          const id = input.lookup.replace(/^openbrain:\/\/memory\//, "");
          if (!id) return null;
          let client;
          try {
            client = await clientFromApi(api);
          } catch {
            return null;
          }
          let memory;
          try {
            memory = await client.inspectMemory(id);
          } catch {
            return null;
          }
          if (!memory || typeof memory !== "object") return null;
          const policy = memory?.use_policy ?? {};
          const provenance = policy?.can_use_as_instruction ? "instruction" : policy?.can_use_as_evidence ? "evidence" : void 0;
          const content = String(memory?.content ?? memory?.summary ?? "");
          return {
            corpus: "openbrain",
            path: input.lookup,
            title: typeof memory?.summary === "string" ? memory.summary.slice(0, 80) : void 0,
            kind: "memory",
            content,
            fromLine: 1,
            lineCount: content.split("\n").length,
            id: typeof memory?.id === "string" ? memory.id : id,
            provenanceLabel: provenance,
            sourceType: "openbrain.agent_memory",
            updatedAt: typeof memory?.updated_at === "string" ? memory.updated_at : void 0
          };
        }
      });
    }
  }
});
export {
  index_default as default
};
