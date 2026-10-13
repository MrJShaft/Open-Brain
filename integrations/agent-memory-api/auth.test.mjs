import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateAgent,
  isWorkspaceAllowed,
  ownsPersonalMemory,
  ownsRecallTrace,
  hasCapability,
  sha256Hex,
} from "./auth.js";

const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);

async function credentialStore() {
  const rowsByDigest = new Map();
  const entries = [
    { token: tokenA, agent_id: "agent_a", workspace_ids: ["workspace_a"] },
    { token: tokenB, agent_id: "agent_b", workspace_ids: ["workspace_a", "workspace_b"] },
  ];
  for (const entry of entries) {
    const digest = await sha256Hex(entry.token);
    rowsByDigest.set(digest, {
      agent_id: entry.agent_id,
      token_sha256: digest,
      workspace_ids: entry.workspace_ids,
      enabled: true,
    });
  }
  return async (digest) => rowsByDigest.get(digest) ?? null;
}

test("a bearer token resolves through its digest to one immutable Agent and workspace allowlist", async () => {
  const lookup = await credentialStore();
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, lookup);

  assert.deepEqual(agentA, { agentId: "agent_a", workspaceIds: ["workspace_a"], capabilities: [] });
  assert.equal(await authenticateAgent(`Bearer ${"c".repeat(43)}`, lookup), null);
});

test("missing, malformed, and legacy shared-key headers do not query or authenticate", async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return null; };

  assert.equal(await authenticateAgent(undefined, lookup), null);
  assert.equal(await authenticateAgent(tokenA, lookup), null);
  assert.equal(await authenticateAgent("Bearer short", lookup), null);
  assert.equal(await authenticateAgent(`x-brain-key: ${tokenA}`, lookup), null);
  assert.equal(lookups, 0);
});

test("malformed credential rows fail closed and a mismatched digest is rejected", async () => {
  await assert.rejects(
    authenticateAgent(`Bearer ${tokenA}`, async () => ({
      agent_id: " agent_a",
      token_sha256: await sha256Hex(tokenA),
      workspace_ids: ["workspace_a"],
      enabled: true,
    })),
    /invalid Agent ID/,
  );
  assert.equal(await authenticateAgent(`Bearer ${tokenA}`, async () => ({
    agent_id: "agent_a",
    token_sha256: "0".repeat(64),
    workspace_ids: ["workspace_a"],
    enabled: true,
  })), null);
  await assert.rejects(
    authenticateAgent(`Bearer ${tokenA}`, async () => ({
      agent_id: "agent_a",
      token_sha256: await sha256Hex(tokenA),
      workspace_ids: [],
      enabled: true,
    })),
    /workspace allowlist/,
  );
});

test("disabled credentials are not accepted", async () => {
  const digest = await sha256Hex(tokenA);
  assert.equal(await authenticateAgent(`Bearer ${tokenA}`, async () => ({
    agent_id: "agent_a",
    token_sha256: digest,
    workspace_ids: ["workspace_a"],
    enabled: false,
  })), null);
});

test("a personal-memory access attempt is denied across Agent and workspace boundaries", async () => {
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, await credentialStore());
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
  const agentA = await authenticateAgent(`Bearer ${tokenA}`, await credentialStore());

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

test("capabilities are parsed, deduplicated, and unknown capabilities fail closed", async () => {
  const digest = await sha256Hex(tokenA);
  const row = (capabilities) => async () => ({ agent_id: "agent_a", token_sha256: digest, workspace_ids: ["w"], enabled: true, capabilities });
  const approver = await authenticateAgent(`Bearer ${tokenA}`, row(["shared:approve", "shared:approve"]));
  assert.deepEqual(approver.capabilities, ["shared:approve"]);
  assert.equal(hasCapability(approver, "shared:approve"), true);
  assert.equal(hasCapability(approver, "thoughts:read"), false);
  const plain = await authenticateAgent(`Bearer ${tokenA}`, row(undefined));
  assert.equal(hasCapability(plain, "shared:approve"), false);
  await assert.rejects(authenticateAgent(`Bearer ${tokenA}`, row(["admin:*"])));
  await assert.rejects(authenticateAgent(`Bearer ${tokenA}`, row("shared:approve")));
});
