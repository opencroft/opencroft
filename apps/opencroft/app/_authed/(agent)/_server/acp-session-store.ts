import { getSetting, upsertSetting } from '@/server/data'

// Durable map of chat tab → the agent's ACP session id, stored in the settings
// table (the data volume) — like the global MCP server list in mcp-store.ts —
// so a chat can be resumed via session/load after a server restart or image
// update. A cwd JSON sidecar would be wiped on deploy.
const SETTING_ID = 'agent-tab-sessions'

/**
 * What a tab's pointer records. `prompted` is the difference between a session
 * that has been given its opening context and one that exists but has never
 * been spoken to — a session is now written here the moment it is created, so
 * the two are no longer the same thing and a resume has to be able to tell
 * them apart. Getting it wrong in one direction re-states a task the agent
 * already has; in the other it drops the agent into a conversation with no
 * idea what it is for.
 */
export interface PersistedSession {
  id: string
  prompted: boolean
}

// An entry written before `prompted` existed is a bare session id. Those were
// only ever written AFTER a first prompt, so `true` is what they meant.
type StoredValue = string | PersistedSession
type Store = Record<string, StoredValue>

function normalize(value: StoredValue | undefined): PersistedSession | null {
  if (typeof value === 'string') {
    return { id: value, prompted: true }
  }
  return value ? { id: value.id, prompted: value.prompted } : null
}

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

export async function readPersistedSession(tabKey: string): Promise<PersistedSession | null> {
  return normalize((await readStore())[tabKey])
}

/**
 * `prompted` only ever moves false → true: a session that has been given its
 * context does not lose it because something later re-registered the pointer.
 */
export async function writePersistedSession(tabKey: string, sessionId: string, prompted: boolean): Promise<void> {
  const store = await readStore()
  const current = normalize(store[tabKey])
  const next: PersistedSession = {
    id: sessionId,
    prompted: current?.id === sessionId ? current.prompted || prompted : prompted,
  }
  if (current && current.id === next.id && current.prompted === next.prompted) {
    return
  }
  store[tabKey] = next
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
