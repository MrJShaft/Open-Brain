import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateAgent,
  isWorkspaceAllowed,
  ownsPersonalMemory,
  ownsRecallTrace,
  parseAgentCredentials,
  sha256Hex,
} from "./auth.js";

const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);

async function credentialMap() {
  return parseAgentCredentials(JSON.stringify({
    agent_a: { token_sha256: await sha256Hex(tokenA), workspace_ids: ["workspace_a"] },
    agent_b: { token_sha256: await sha256Hex(tokenB), workspace_ids: ["workspace_a", "workspace_b"] },
  }));
}

test("a bearer token resolves only to its configured Agent and workspace allowlist", async () => {
  const credentials = await credentialMap();
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, credentials);

  assert.deepEqual(agentA, { agentId: "agent_a", workspaceIds: ["workspace_a"] });
  assert.equal(await authenticateAgent(`Bearer ${"c".repeat(43)}`, credentials), null);
});

test("missing, malformed, and legacy shared-key headers do not authenticate", async () => {
  const credentials = await credentialMap();

  assert.equal(await authenticateAgent(undefined, credentials), null);
  assert.equal(await authenticateAgent(tokenA, credentials), null);
  assert.equal(await authenticateAgent(`Bearer short`, credentials), null);
  assert.equal(await authenticateAgent(`x-brain-key: ${tokenA}`, credentials), null);
});

test("empty, malformed, ambiguous, or unscoped credentials fail closed", async () => {
  assert.equal(await authenticateAgent(`Bearer ${tokenA}`, parseAgentCredentials("")), null);
  assert.throws(() => parseAgentCredentials("not-json"), /valid JSON/);
  assert.throws(() => parseAgentCredentials(JSON.stringify({ agent_a: { token_sha256: "short", workspace_ids: ["workspace_a"] } })), /64-character/);
  assert.throws(() => parseAgentCredentials(JSON.stringify({ agent_a: { token_sha256: "a".repeat(64), workspace_ids: [] } })), /workspace_ids/);
  assert.throws(() => parseAgentCredentials(JSON.stringify({ agent_a: { token_sha256: "a".repeat(64), workspace_ids: ["workspace_a", "workspace_a"] } })), /duplicates/);
  assert.throws(() => parseAgentCredentials(JSON.stringify({ agent_a: { token_sha256: "a".repeat(64), workspace_ids: ["workspace_a"], extra: true } })), /only token_sha256 and workspace_ids/);
});

test("one token digest cannot be assigned to more than one Agent", async () => {
  const digest = await sha256Hex(tokenA);
  assert.throws(() => parseAgentCredentials(JSON.stringify({
    first: { token_sha256: digest, workspace_ids: ["workspace_a"] },
    second: { token_sha256: digest, workspace_ids: ["workspace_a"] },
  })), /multiple Agents/);
});

test("a personal-memory access attempt is denied across Agent and workspace boundaries", async () => {
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, await credentialMap());
  const memoryOwnedByA = { authenticated_agent_id: "agent_a" };
  const memoryOwnedByB = { authenticated_agent_id: "agent_b" };

  assert.equal(isWorkspaceAllowed(agentA.workspaceIds, "workspace_a"), true);
  assert.equal(isWorkspaceAllowed(agentA.workspaceIds, "workspace_b"), false);
  assert.equal(ownsPersonalMemory(agentA, "workspace_a", memoryOwnedByA), true);
  assert.equal(ownsPersonalMemory(agentA, "workspace_a", memoryOwnedByB), false);
  assert.equal(ownsPersonalMemory(agentA, "workspace_b", memoryOwnedByA), false);
  assert.equal(ownsPersonalMemory(agentA, "workspace_a", {}), false);
});

test("a trace/request-ID access attempt is denied across Agent and workspace boundaries", async () => {
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, await credentialMap());

  assert.equal(ownsRecallTrace(agentA, {
    workspace_id: "workspace_a",
    request_payload: { authenticated_agent_id: "agent_a" },
  }), true);
  assert.equal(ownsRecallTrace(agentA, {
    workspace_id: "workspace_a",
    request_payload: { authenticated_agent_id: "agent_b" },
  }), false);
  assert.equal(ownsRecallTrace(agentA, {
    workspace_id: "workspace_b",
    request_payload: { authenticated_agent_id: "agent_a" },
  }), false);
  assert.equal(ownsRecallTrace(agentA, { workspace_id: "workspace_a", request_payload: {} }), false);
});
