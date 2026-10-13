const SHA256_HEX = /^[a-f0-9]{64}$/i;
const BEARER_TOKEN = /^Bearer\s+([A-Za-z0-9_-]{43,})$/i;

/** Parse a JSON object mapping immutable Agent IDs to SHA-256 token digests. */
export function parseAgentKeyHashes(raw) {
  if (!raw || !raw.trim()) return new Map();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_API_KEY_HASHES_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_API_KEY_HASHES_JSON must be an object of Agent IDs to SHA-256 token digests.");
  }

  const result = new Map();
  const seenDigests = new Set();
  for (const [agentId, digest] of Object.entries(parsed)) {
    if (!agentId || agentId.trim() !== agentId || agentId.length > 256) {
      throw new Error("AGENT_API_KEY_HASHES_JSON contains an invalid Agent ID.");
    }
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new Error("AGENT_API_KEY_HASHES_JSON values must be 64-character SHA-256 hex digests.");
    }
    const normalizedDigest = digest.toLowerCase();
    if (seenDigests.has(normalizedDigest)) {
      throw new Error("AGENT_API_KEY_HASHES_JSON cannot assign one token to multiple Agents.");
    }
    seenDigests.add(normalizedDigest);
    result.set(agentId, normalizedDigest);
  }
  return result;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return the configured Agent ID for a valid bearer token, or null. */
export async function authenticateAgent(authorization, keyHashes) {
  if (typeof authorization !== "string") return null;
  const match = BEARER_TOKEN.exec(authorization.trim());
  if (!match) return null;

  const candidateDigest = await sha256Hex(match[1]);
  let authenticatedAgentId = null;
  for (const [agentId, expectedDigest] of keyHashes) {
    if (constantTimeEqual(candidateDigest, expectedDigest)) authenticatedAgentId = agentId;
  }
  return authenticatedAgentId;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
