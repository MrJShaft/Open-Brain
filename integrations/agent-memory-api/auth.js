const SHA256_HEX = /^[a-f0-9]{64}$/i;
/** Capabilities a credential may carry. Anything else fails closed. */
export const KNOWN_CAPABILITIES = Object.freeze(["thoughts:read", "shared:approve"]);
const BEARER_TOKEN = /^Bearer\s+([A-Za-z0-9_-]{43,})$/i;

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Look up the bearer-token digest in the protected credential store and return its Agent scope. */
export async function authenticateAgent(authorization, lookupCredentialByDigest) {
  if (typeof authorization !== "string") return null;
  const match = BEARER_TOKEN.exec(authorization.trim());
  if (!match) return null;
  if (typeof lookupCredentialByDigest !== "function") {
    throw new TypeError("A credential lookup function is required.");
  }

  const candidateDigest = await sha256Hex(match[1]);
  const credential = await lookupCredentialByDigest(candidateDigest);
  if (!credential) return null;
  if (credential.enabled !== true) return null;
  if (typeof credential.agent_id !== "string" || credential.agent_id.trim() !== credential.agent_id || credential.agent_id.length < 1 || credential.agent_id.length > 256 || /[\u0000-\u001f\u007f]/.test(credential.agent_id)) {
    throw new Error("Credential registry contains an invalid Agent ID.");
  }
  if (typeof credential.token_sha256 !== "string" || !SHA256_HEX.test(credential.token_sha256)) {
    throw new Error("Credential registry contains an invalid token digest.");
  }
  if (!constantTimeEqual(candidateDigest, credential.token_sha256.toLowerCase())) return null;
  if (!Array.isArray(credential.workspace_ids) || credential.workspace_ids.length < 1 || credential.workspace_ids.length > 100) {
    throw new Error("Credential registry contains an invalid workspace allowlist.");
  }

  const workspaceIds = [];
  const seenWorkspaces = new Set();
  for (const workspaceId of credential.workspace_ids) {
    if (typeof workspaceId !== "string" || workspaceId.trim() !== workspaceId || workspaceId.length < 1 || workspaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(workspaceId)) {
      throw new Error("Credential registry contains an invalid workspace ID.");
    }
    if (seenWorkspaces.has(workspaceId)) {
      throw new Error("Credential registry contains a duplicate workspace ID.");
    }
    seenWorkspaces.add(workspaceId);
    workspaceIds.push(workspaceId);
  }

  const rawCapabilities = credential.capabilities ?? [];
  if (!Array.isArray(rawCapabilities) || rawCapabilities.some((cap) => typeof cap !== "string" || !KNOWN_CAPABILITIES.includes(cap))) {
    throw new Error("Credential registry contains an invalid capability.");
  }
  const capabilities = [...new Set(rawCapabilities)];

  return { agentId: credential.agent_id, workspaceIds, capabilities };
}

export function hasCapability(agent, capability) {
  return Boolean(agent && Array.isArray(agent.capabilities) && agent.capabilities.includes(capability));
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
