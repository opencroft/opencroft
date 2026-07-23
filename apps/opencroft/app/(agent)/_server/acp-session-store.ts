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

// Durable map of chat tab -> config-option overrides the user set on that
// session (e.g. reasoning effort), stored the same way as the session
// pointer above. setConfigOption's changes are session-only in agentClient's
// memory — they never survive a cold-start session/load resume, which
// recreates the agentClient-side session object from scratch. Persisting
// them here lets openLocalSession replay them right after a successful
// resume, so a per-session override actually stays set.
const CONFIG_OPTIONS_SETTING_ID = 'agent-tab-config-options'

type ConfigOptionsStore = Record<string, Record<string, string | boolean>>

async function readConfigOptionsStore(): Promise<ConfigOptionsStore> {
  const row = await getSetting(CONFIG_OPTIONS_SETTING_ID)
  if (!row) {
    return {}
  }
  return (JSON.parse(row.data) as { options?: ConfigOptionsStore }).options ?? {}
}

async function writeConfigOptionsStore(store: ConfigOptionsStore): Promise<void> {
  await upsertSetting(CONFIG_OPTIONS_SETTING_ID, JSON.stringify({ options: store }))
}

export async function readPersistedConfigOptions(tabKey: string): Promise<Record<string, string | boolean>> {
  return (await readConfigOptionsStore())[tabKey] ?? {}
}

export async function writePersistedConfigOption(
  tabKey: string,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const store = await readConfigOptionsStore()
  store[tabKey] = { ...(store[tabKey] ?? {}), [configId]: value }
  await writeConfigOptionsStore(store)
}

export async function deletePersistedConfigOptions(tabKey: string): Promise<void> {
  const store = await readConfigOptionsStore()
  if (!(tabKey in store)) {
    return
  }
  delete store[tabKey]
  await writeConfigOptionsStore(store)
}
