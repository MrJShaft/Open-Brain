const SHA256_HEX = /^[a-f0-9]{64}$/i;
const BEARER_TOKEN = /^Bearer\s+([A-Za-z0-9_-]{43,})$/i;

/** Parse immutable Agent IDs to { token_sha256, workspace_ids } credentials. */
export function parseAgentCredentials(raw) {
  if (!raw || !raw.trim()) return new Map();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_API_CREDENTIALS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_API_CREDENTIALS_JSON must be an object of Agent credentials.");
  }

  const result = new Map();
  const seenDigests = new Set();
  for (const [agentId, credential] of Object.entries(parsed)) {
    if (!agentId || agentId.trim() !== agentId || agentId.length > 256) {
      throw new Error("AGENT_API_CREDENTIALS_JSON contains an invalid Agent ID.");
    }
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
      throw new Error("Each Agent credential must be an object.");
    }
    const keys = Object.keys(credential).sort();
    if (keys.length !== 2 || keys[0] !== "token_sha256" || keys[1] !== "workspace_ids") {
      throw new Error("Each Agent credential must contain only token_sha256 and workspace_ids.");
    }
    if (typeof credential.token_sha256 !== "string" || !SHA256_HEX.test(credential.token_sha256)) {
      throw new Error("token_sha256 must be a 64-character SHA-256 hex digest.");
    }
    if (!Array.isArray(credential.workspace_ids) || credential.workspace_ids.length < 1 || credential.workspace_ids.length > 100) {
      throw new Error("workspace_ids must contain between 1 and 100 authorized workspace IDs.");
    }

    const workspaceIds = [];
    const seenWorkspaces = new Set();
    for (const workspaceId of credential.workspace_ids) {
      if (typeof workspaceId !== "string" || workspaceId.trim() !== workspaceId || workspaceId.length < 1 || workspaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(workspaceId)) {
        throw new Error("workspace_ids contains an invalid workspace ID.");
      }
      if (seenWorkspaces.has(workspaceId)) {
        throw new Error("workspace_ids cannot contain duplicates.");
      }
      seenWorkspaces.add(workspaceId);
      workspaceIds.push(workspaceId);
    }

    const normalizedDigest = credential.token_sha256.toLowerCase();
    if (seenDigests.has(normalizedDigest)) {
      throw new Error("AGENT_API_CREDENTIALS_JSON cannot assign one token to multiple Agents.");
    }
    seenDigests.add(normalizedDigest);
    result.set(agentId, { digest: normalizedDigest, workspaceIds });
  }
  return result;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return the configured Agent identity and workspace allowlist for a valid bearer token. */
export async function authenticateAgent(authorization, credentials) {
  if (typeof authorization !== "string") return null;
  const match = BEARER_TOKEN.exec(authorization.trim());
  if (!match) return null;

  const candidateDigest = await sha256Hex(match[1]);
  let authenticatedAgent = null;
  for (const [agentId, credential] of credentials) {
    if (constantTimeEqual(candidateDigest, credential.digest)) {
      authenticatedAgent = { agentId, workspaceIds: [...credential.workspaceIds] };
    }
  }
  return authenticatedAgent;
}

export function isWorkspaceAllowed(workspaceIds, workspaceId) {
  return typeof workspaceId === "string" && Array.isArray(workspaceIds) && workspaceIds.includes(workspaceId);
}

export function ownsPersonalMemory(agent, workspaceId, metadata) {
  return Boolean(
    agent &&
    isWorkspaceAllowed(agent.workspaceIds, workspaceId) &&
    metadata &&
    typeof metadata === "object" &&
    metadata.authenticated_agent_id === agent.agentId,
  );
}

export function ownsRecallTrace(agent, trace) {
  return Boolean(
    trace &&
    ownsPersonalMemory(agent, trace.workspace_id, trace.request_payload),
  );
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
