import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'

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

function storeFromRaw(raw: Record<string, unknown>): Store {
  return (raw as { sessions?: Store }).sessions ?? {}
}

export async function readPersistedSession(tabKey: string): Promise<PersistedSession | null> {
  const row = await getSettingImpl(SETTING_ID)
  const store = row ? storeFromRaw(row.data) : {}
  return normalize(store[tabKey])
}

/**
 * `prompted` only ever moves false → true: a session that has been given its
 * context does not lose it because something later re-registered the pointer.
 *
 * Read-modify-write against the shared `agent-tab-sessions` row, so this goes
 * through the mutex + version-CAS mechanism (settings-cas.ts) rather than a
 * plain read-then-write — two tab keys writing concurrently share that one
 * row, and a plain write here has the identical lost-update shape already
 * closed for extension storage.
 */
export async function writePersistedSession(tabKey: string, sessionId: string, prompted: boolean): Promise<void> {
  await withSettingLock(SETTING_ID, () =>
    mutateSettingData(SETTING_ID, (raw) => {
      const store = storeFromRaw(raw)
      const current = normalize(store[tabKey])
      const next: PersistedSession = {
        id: sessionId,
        prompted: current?.id === sessionId ? current.prompted || prompted : prompted,
      }
      if (current && current.id === next.id && current.prompted === next.prompted) {
        return raw
      }
      return { sessions: { ...store, [tabKey]: next } }
    }),
  )
}

export async function deletePersistedSession(tabKey: string): Promise<void> {
  await withSettingLock(SETTING_ID, () =>
    mutateSettingData(SETTING_ID, (raw) => {
      const store = storeFromRaw(raw)
      if (!(tabKey in store)) {
        return raw
      }
      const next = { ...store }
      delete next[tabKey]
      return { sessions: next }
    }),
  )
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

function configOptionsStoreFromRaw(raw: Record<string, unknown>): ConfigOptionsStore {
  return (raw as { options?: ConfigOptionsStore }).options ?? {}
}

export async function readPersistedConfigOptions(tabKey: string): Promise<Record<string, string | boolean>> {
  const row = await getSettingImpl(CONFIG_OPTIONS_SETTING_ID)
  const store = row ? configOptionsStoreFromRaw(row.data) : {}
  return store[tabKey] ?? {}
}

export async function writePersistedConfigOption(
  tabKey: string,
  configId: string,
  value: string | boolean,
): Promise<void> {
  await withSettingLock(CONFIG_OPTIONS_SETTING_ID, () =>
    mutateSettingData(CONFIG_OPTIONS_SETTING_ID, (raw) => {
      const store = configOptionsStoreFromRaw(raw)
      const nextTab = { ...(store[tabKey] ?? {}), [configId]: value }
      return { options: { ...store, [tabKey]: nextTab } }
    }),
  )
}

export async function deletePersistedConfigOptions(tabKey: string): Promise<void> {
  await withSettingLock(CONFIG_OPTIONS_SETTING_ID, () =>
    mutateSettingData(CONFIG_OPTIONS_SETTING_ID, (raw) => {
      const store = configOptionsStoreFromRaw(raw)
      if (!(tabKey in store)) {
        return raw
      }
      const next = { ...store }
      delete next[tabKey]
      return { options: next }
    }),
  )
}
