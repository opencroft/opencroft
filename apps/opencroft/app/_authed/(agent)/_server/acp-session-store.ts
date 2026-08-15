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

// Durable last-known context usage per ACP session id. ACP has no way to ASK an
// agent how much context a session holds: `size`/`used` arrive only as
// `usage_update` notifications the agent pushes, and in practice only during a
// turn (checked against @agentclientprotocol/sdk 1.3.0 — UsageUpdate is the
// only type in the schema carrying a window size, and neither
// NewSessionResponse, LoadSessionResponse nor session/list's SessionInfo
// repeats it). agentClient mirrors the last one in memory, which covers
// reopening a chat while the session object is still alive — but an idle
// unload (agent nodes opting into autoUnloadIdle) or a process restart drops
// it, and the reopened chat then shows no context ring until the next turn
// ends. Persisting it here lets openLocalSession seed the resumed session so
// the ring is populated on open.
//
// Keyed by ACP session id rather than tab key: the write happens on turn end,
// where only the session id is in hand, and a reverse lookup per turn would
// cost a read of the tab-pointer row. The trade is that entries are not
// deleted with their tab, so the row is capped (see USAGE_CAP).
const USAGE_SETTING_ID = 'agent-session-usage'

/**
 * `used` is the token count the agent last reported, `at` the wall-clock time
 * it was recorded — kept so the cap below can evict oldest-first, and so a
 * consumer can tell a fresh reading from a stale one.
 *
 * A restored `used` is by construction the value at the END of the last turn:
 * if the agent compacted on its own or rebuilt context differently on resume,
 * it is an estimate until the next real `usage_update` overwrites it. `size`
 * does not have that problem — a model's context window does not drift.
 */
export interface PersistedUsage {
  used: number
  size?: number
  at: number
}

// Sessions are never explicitly unregistered from this row, so cap it and drop
// oldest-first. Well above any plausible number of live chats, small enough
// that the row stays a few KB.
const USAGE_CAP = 200

type UsageStore = Record<string, PersistedUsage>

function usageStoreFromRaw(raw: Record<string, unknown>): UsageStore {
  return (raw as { usage?: UsageStore }).usage ?? {}
}

export async function readPersistedUsage(sessionId: string): Promise<PersistedUsage | null> {
  const row = await getSettingImpl(USAGE_SETTING_ID)
  const store = row ? usageStoreFromRaw(row.data) : {}
  return store[sessionId] ?? null
}

/**
 * The last-known usage for a session key an offline session left behind —
 * resolved through the durable tabKey pointer to the ACP session id
 * `readPersistedUsage` is actually keyed by, since a session that has gone
 * offline is not in agent-client's memory to ask directly. Works for any key
 * this store's pointer namespace covers (a 1:1 chat tab, an agent:job
 * dispatch, or a group-chat thread — they all resolve through the same
 * `agent-tab-sessions` pointer). Null when there is no pointer for this key,
 * or the pointer's session never reported usage before going offline — the
 * same UNKNOWN a session that has never been loaded reports.
 */
export async function readLastKnownUsage(sessionKey: string): Promise<PersistedUsage | null> {
  const pointer = await readPersistedSession(sessionKey)
  return pointer ? readPersistedUsage(pointer.id) : null
}

export async function writePersistedUsage(sessionId: string, usage: { used: number; size?: number }): Promise<void> {
  await withSettingLock(USAGE_SETTING_ID, () =>
    mutateSettingData(USAGE_SETTING_ID, (raw) => {
      const store = usageStoreFromRaw(raw)
      const current = store[sessionId]
      if (current && current.used === usage.used && current.size === usage.size) {
        return raw
      }
      const next: UsageStore = { ...store, [sessionId]: { used: usage.used, size: usage.size, at: Date.now() } }
      const ids = Object.keys(next)
      if (ids.length > USAGE_CAP) {
        // Oldest-first eviction. The session being written is always the newest,
        // so it can never evict itself.
        const evict = ids.sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0)).slice(0, ids.length - USAGE_CAP)
        for (const id of evict) {
          delete next[id]
        }
      }
      return { usage: next }
    }),
  )
}
