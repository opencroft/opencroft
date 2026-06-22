import { createFileRoute } from '@tanstack/react-router'

import { type ChatTabsState, readChatTabs, writeChatTabs } from '@/app/(agent)/_server/chat-tabs-store'

// Open AI-panel chat tabs + chat mode, persisted in the settings DB (not browser
// localStorage) so open chats follow the user across browsers and survive a
// cache clear. Mirrors the MCP server list in acp.mcp.ts.
export const Route = createFileRoute('/(agent)/api/acp/tabs')({
  server: {
    handlers: {
      GET: async () => Response.json(await readChatTabs()),
      POST: async ({ request }) => {
        const state = (await request.json()) as ChatTabsState
        await writeChatTabs(state)
        return Response.json({ ok: true })
      },
    },
  },
})
