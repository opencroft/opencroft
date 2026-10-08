import { parseAvatarDataUrl } from '@opencroft/auth/server'

import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'
import { decodeAvatarDataUrl, type StoredAvatar, versionedAvatarAddress } from '@/app/_server/user-avatar'

/**
 * An agent's avatar as something a browser can cache -- the agent-side twin of
 * `userAvatarUrl`.
 *
 * An agent's picture is a data URL on its graph node, and nothing bounds its
 * size. Handed to a page as-is it travels inside every list that names the
 * agent, once per row that names it, and is never cached. So a page gets
 * `/api/avatars/agents/<nodeId>?v=<version>` instead, served once per version.
 *
 * SERVER-ONLY: it reads the space graphs and hashes with node:crypto.
 */
export function agentAvatarUrl(agent: { nodeId: string; avatar?: string | null }): string | null {
  const image = agent.avatar
  if (!image) {
    return null
  }
  // Only what the route can serve is given its address. Anything else -- an
  // `http(s)` address, or a data URL of a type the route refuses -- is handed
  // over as stored, which is how every agent picture was drawn before.
  if (!parseAvatarDataUrl(image)) {
    return image
  }
  return versionedAvatarAddress(`/api/avatars/agents/${encodeURIComponent(agent.nodeId)}`, image)
}

/** The stored picture of one agent node, decoded, or null when there is none to serve. */
export async function readStoredAgentAvatar(nodeId: string): Promise<StoredAvatar | null> {
  const node = (await listAgentNodesImpl()).find((n) => n.nodeId === nodeId)
  return node?.avatar ? decodeAvatarDataUrl(node.avatar) : null
}
