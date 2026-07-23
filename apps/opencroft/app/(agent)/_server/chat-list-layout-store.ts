import { getSetting, upsertSetting } from '@/server/data'

// Sidebar chat-list order + folder structure, stored in the settings table so
// it follows the user across devices — like chat-tabs-store.ts. Only the
// skeleton (ids, folder names/order, hidden keys) is persisted; item
// titles/avatars are re-hydrated from the session registry
// (agent-sessions-store.ts) on read, so a session's display data never goes
// stale here.
const SETTING_ID = 'agent-chat-list-layout'

export interface ChatListLayoutFolder {
  id: string
  name: string
  open?: boolean
  itemKeys: string[]
}

export type ChatListLayoutEntry = { kind: 'item'; key: string } | { kind: 'folder'; folder: ChatListLayoutFolder }

export interface ChatListLayout {
  entries: ChatListLayoutEntry[]
  // Sessions closed from the sidebar list — hidden here, not deleted. A
  // session reopened through any other path (e.g. the canvas session
  // picker) is expected to be removed from this set again by the caller.
  hiddenKeys: string[]
}

const EMPTY_LAYOUT: ChatListLayout = { entries: [], hiddenKeys: [] }

export async function readChatListLayout(): Promise<ChatListLayout> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return EMPTY_LAYOUT
  }
  // A corrupt row must degrade to an empty layout, not 500 the route — the
  // client already treats an empty layout as "nothing persisted yet".
  try {
    const parsed = JSON.parse(row.data) as Partial<ChatListLayout>
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      hiddenKeys: Array.isArray(parsed.hiddenKeys) ? parsed.hiddenKeys : [],
    }
  } catch {
    return EMPTY_LAYOUT
  }
}

export async function writeChatListLayout(layout: ChatListLayout): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify(layout))
}
