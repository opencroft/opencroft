import { defineEventHandler } from 'nitro/h3'

import { readStoredAgentAvatar } from '@/app/_server/agent-avatar'
import { requireSession } from '@/app/_server/require-session'
import { avatarResponse } from '@/app/_server/user-avatar'

// An agent's avatar, at /api/avatars/agents/<nodeId>?v=<version> -- the
// address agentAvatarUrl gives a page to draw the picture from. A Nitro route
// for the same reason as the person's avatar route beside it: it is drawn by
// an <img>, which only reaches Nitro's own routes under the dev server.
export default defineEventHandler(async (event) => {
  const nodeId = decodedParam(event.context.params?.nodeId)
  if (!nodeId) {
    return new Response('Not found', { status: 404 })
  }
  const denied = await requireSession(event.req)
  if (denied) return denied
  return avatarResponse(event.req, await readStoredAgentAvatar(nodeId))
})

// h3 keeps route params as they were in the path; a malformed escape names no
// agent instead of throwing.
function decodedParam(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}
