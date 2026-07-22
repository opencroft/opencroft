import { getSetting, upsertSetting } from '@/server/data'

// Sidebar chat-list order + folder structure, stored in the settings table so
// it follows the user across devices — like chat-tabs-store.ts. Only the
// skeleton (ids, folder names/order) is persisted; item titles/avatars are
// re-hydrated from the session registry (agent-sessions-store.ts) on read, so
// a session's display data never goes stale here.
const SETTING_ID = 'agent-chat-list-layout'

export interface ChatListLayoutFolder {
  id: string
  name: string
  open?: boolean
  itemKeys: string[]
}

export type ChatListLayoutEntry = { kind: 'item'; key: string } | { kind: 'folder'; folder: ChatListLayoutFolder }

export async function readChatListLayout(): Promise<ChatListLayoutEntry[]> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return []
  }
  // A corrupt row must degrade to an empty layout, not 500 the route — the
  // client already treats an empty layout as "nothing persisted yet".
  try {
    const parsed = JSON.parse(row.data) as { entries?: ChatListLayoutEntry[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

export async function writeChatListLayout(entries: ChatListLayoutEntry[]): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify({ entries }))
}
