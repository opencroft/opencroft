import type { ChatMode, ChatTab } from '@/app/(agent)/_lib/chat-tabs-context'
import { getSetting, upsertSetting } from '@/server/data'

// Open AI-panel chat tabs + chat mode, stored in the settings table (the data
// volume) rather than browser localStorage — like the global MCP server list in
// mcp-store.ts — so open chats follow the user across browsers/devices and
// survive a cache clear.
const SETTING_ID = 'agent-chat-tabs'

export interface ChatTabsState {
  tabs: ChatTab[]
  mode: ChatMode
}

const EMPTY: ChatTabsState = { tabs: [], mode: 'docked' }

export async function readChatTabs(): Promise<ChatTabsState> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return EMPTY
  }
  const parsed = JSON.parse(row.data) as Partial<ChatTabsState>
  return {
    tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
    mode: parsed.mode === 'focused' ? 'focused' : 'docked',
  }
}

export async function writeChatTabs(state: ChatTabsState): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify(state))
}
