import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import {
  type ChatListLayout,
  readChatListLayout,
  writeChatListLayout,
} from '@/app/_authed/(agent)/_server/chat-list-layout-store'

// Sidebar chat-list order + folder structure + hidden (closed) sessions.
// Mirrors acp.tabs.ts's shape: GET the current layout, POST replaces it
// wholesale (the sidebar always sends its full current tree on every
// structural change).
export const Route = createFileRoute('/_authed/(agent)/api/acp/chat-list-layout')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        return Response.json(await readChatListLayout())
      },
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const body = (await request.json()) as ChatListLayout
        await writeChatListLayout({
          entries: Array.isArray(body.entries) ? body.entries : [],
          hiddenKeys: Array.isArray(body.hiddenKeys) ? body.hiddenKeys : [],
        })
        return Response.json({ ok: true })
      },
    },
  },
})
