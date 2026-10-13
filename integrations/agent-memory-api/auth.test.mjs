import assert from "node:assert/strict";
import test from "node:test";

import { authenticateAgent, parseAgentKeyHashes, sha256Hex } from "./auth.js";

test("an Agent bearer token resolves only to its configured immutable Agent ID", async () => {
  const agentId = "agent_test_123";
  const token = "a".repeat(43);
  const hashes = parseAgentKeyHashes(JSON.stringify({ [agentId]: await sha256Hex(token) }));

  assert.equal(await authenticateAgent(`Bearer ${token}`, hashes), agentId);
  assert.equal(await authenticateAgent(`Bearer ${"b".repeat(43)}`, hashes), null);
});

test("missing, malformed, and legacy shared-key headers do not authenticate", async () => {
  const hashes = parseAgentKeyHashes(JSON.stringify({ agent: await sha256Hex("a".repeat(43)) }));

  assert.equal(await authenticateAgent(undefined, hashes), null);
  assert.equal(await authenticateAgent("a".repeat(43), hashes), null);
  assert.equal(await authenticateAgent(`Bearer ${"short"}`, hashes), null);
  assert.equal(await authenticateAgent(`x-brain-key: ${"a".repeat(43)}`, hashes), null);
});

test("an empty key map denies every token and malformed maps fail closed", async () => {
  assert.equal(await authenticateAgent(`Bearer ${"a".repeat(43)}`, parseAgentKeyHashes("")), null);
  assert.throws(() => parseAgentKeyHashes("not-json"), /valid JSON/);
  assert.throws(() => parseAgentKeyHashes(JSON.stringify({ agent: "short" })), /64-character/);
});

test("one token digest cannot be assigned to more than one Agent", async () => {
  const digest = await sha256Hex("a".repeat(43));
  assert.throws(() => parseAgentKeyHashes(JSON.stringify({ first: digest, second: digest })), /multiple Agents/);
});
