import { getSetting, upsertSetting } from '@/server/data'

// Durable map of chat tab → the agent's ACP session id, stored in the settings
// table (the data volume) — like the global MCP server list in mcp-store.ts —
// so a chat can be resumed via session/load after a server restart or image
// update. A cwd JSON sidecar would be wiped on deploy.
const SETTING_ID = 'agent-tab-sessions'

type Store = Record<string, string>

async function readStore(): Promise<Store> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return {}
  }
  return (JSON.parse(row.data) as { sessions?: Store }).sessions ?? {}
}

async function writeStore(store: Store): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify({ sessions: store }))
}

export async function readPersistedSession(tabKey: string): Promise<string | null> {
  return (await readStore())[tabKey] ?? null
}

export async function writePersistedSession(tabKey: string, sessionId: string): Promise<void> {
  const store = await readStore()
  if (store[tabKey] === sessionId) {
    return
  }
  store[tabKey] = sessionId
  await writeStore(store)
}

export async function deletePersistedSession(tabKey: string): Promise<void> {
  const store = await readStore()
  if (!(tabKey in store)) {
    return
  }
  delete store[tabKey]
  await writeStore(store)
}
