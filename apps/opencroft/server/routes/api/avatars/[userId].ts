import { defineEventHandler } from 'nitro/h3'

import { requireSession } from '@/app/_server/require-session'
import { avatarResponse, readStoredAvatar } from '@/app/_server/user-avatar'

// A person's avatar, at /api/avatars/<id>?v=<version> -- the address
// userAvatarUrl gives a page to draw the picture from.
//
// A NITRO ROUTE, NOT A TANSTACK ONE, for the reason the attachment route gives:
// the title bar draws it with an <img>, and under the dev server only a route
// of Nitro's own is reached by a request whose Sec-Fetch-Dest is `image`.
// As a TanStack route it answered fetch() and 404'd every picture drawn.
export default defineEventHandler(async (event) => {
  const userId = decodedParam(event.context.params?.userId)
  if (!userId) {
    return new Response('Not found', { status: 404 })
  }
  const denied = await requireSession(event.req)
  if (denied) return denied
  return avatarResponse(event.req, await readStoredAvatar(userId))
})

// h3 keeps route params as they were in the path (it decodes only on request,
// in getRouterParam's `decode` option), and userAvatarUrl encodes the id. Done
// here rather than through that option so a malformed escape names nobody
// instead of throwing.
function decodedParam(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}
