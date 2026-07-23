import { createFileRoute } from '@tanstack/react-router'

import { type ChatListLayout, readChatListLayout, writeChatListLayout } from '@/app/(agent)/_server/chat-list-layout-store'

// Sidebar chat-list order + folder structure + hidden (closed) sessions.
// Mirrors acp.tabs.ts's shape: GET the current layout, POST replaces it
// wholesale (the sidebar always sends its full current tree on every
// structural change).
export const Route = createFileRoute('/(agent)/api/acp/chat-list-layout')({
  server: {
    handlers: {
      GET: async () => Response.json(await readChatListLayout()),
      POST: async ({ request }) => {
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
