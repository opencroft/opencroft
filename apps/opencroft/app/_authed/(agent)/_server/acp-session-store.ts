import type { Presence } from 'agent-client/types'

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

/** The tab key whose pointer names this session id, or null when none does. */
export async function findPersistedTabKey(sessionId: string): Promise<string | null> {
  const row = await getSettingImpl(SETTING_ID)
  const store = row ? storeFromRaw(row.data) : {}
  for (const [tabKey, value] of Object.entries(store)) {
    if (normalize(value)?.id === sessionId) {
      return tabKey
    }
  }
  return null
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

// How often each session's agent reads its queue, kept so a reopened session
// reads at the cadence it was set to rather than at the default.
//
// This is a settings row rather than a column on the queue table, because it is
// a per-session SETTING and not a queued thing: it exists for sessions whose
// queue is empty, and it must outlive every message it ever held back.
//
// Keyed by SESSION KEY, matching the durable queue, for the same reason: a
// restart mints a new session id, so an id could not name the session being
// restored into.
//
// Small and rewritten wholesale, which is what the settings store is good at.
// The queue went into a table instead because it is appended to per message;
// this changes when somebody presses a button.
const PRESENCE_SETTING_ID = 'agent-session-presence'

type PresenceStore = Record<string, Presence>

function presenceStoreFromRaw(raw: Record<string, unknown>): PresenceStore {
  return (raw as { presence?: PresenceStore }).presence ?? {}
}

/**
 * The cadence a session was last set to, or null if it was never set.
 *
 * Null rather than the default: "never set" and "deliberately set to realtime"
 * are the same behaviour but not the same fact, and the caller that restores
 * this should be able to leave its own default in place rather than have one
 * asserted over it here.
 */
export async function readPersistedPresence(sessionKey: string): Promise<Presence | null> {
  const row = await getSettingImpl(PRESENCE_SETTING_ID)
  const store = row ? presenceStoreFromRaw(row.data) : {}
  return store[sessionKey] ?? null
}

export async function writePersistedPresence(sessionKey: string, presence: Presence): Promise<void> {
  await withSettingLock(PRESENCE_SETTING_ID, () =>
    mutateSettingData(PRESENCE_SETTING_ID, (raw) => ({
      presence: { ...presenceStoreFromRaw(raw), [sessionKey]: presence },
    })),
  )
}

export async function deletePersistedPresence(sessionKey: string): Promise<void> {
  await withSettingLock(PRESENCE_SETTING_ID, () =>
    mutateSettingData(PRESENCE_SETTING_ID, (raw) => {
      const store = presenceStoreFromRaw(raw)
      if (!(sessionKey in store)) {
        return raw
      }
      const next = { ...store }
      delete next[sessionKey]
      return { presence: next }
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

// ── Moving a tab key ─────────────────────────────────────────────────────
//
// A tab key is derived from something renameable (a group chat's slug, a
// thread's), so renaming re-mints it and everything filed under the old key has
// to move with it. Both rows above are keyed by tab key and both are moved
// here; the usage row further down is NOT, because it is keyed by ACP session
// id and is reached THROUGH the pointer — moving the pointer already carries it.
//
// SPLIT IN TWO ON PURPOSE, and the split is the safety property rather than a
// convenience. There is no transaction spanning a settings row and the database
// row that names the key, so the only way a half-finished move cannot strand a
// session is if the new key already resolves before anything starts using it:
//
//   copyTabKeys   run BEFORE the rename commits. Afterwards both keys point at
//                 the same session, so whichever one a reader ends up holding
//                 finds it. Nothing is addressed by the new key yet, so the
//                 duplicate is inert.
//   dropTabKeys   run AFTER it commits, when the old key is nobody's address
//                 any more.
//
// Interrupted between the two, the worst case is a stale entry under an address
// nothing uses — never a thread whose session cannot be found. Interrupted
// inside either one, the per-row lock means that row moved every key or none.

export interface TabKeyMove {
  from: string
  to: string
}

function movedEntries<T>(
  store: Record<string, T>,
  moves: readonly TabKeyMove[],
  merge: (incoming: T, existing: T | undefined) => T = (incoming) => incoming,
): Record<string, T> | null {
  const next = { ...store }
  let changed = false
  for (const { from, to } of moves) {
    const entry = store[from]
    if (entry === undefined || from === to) {
      continue
    }
    next[to] = merge(entry, store[to])
    changed = true
  }
  return changed ? next : null
}

/**
 * The same rule the pointer gets, for the options: a copy must not undo a write
 * that landed under the destination key.
 *
 * `copyTabKeys` runs twice, and after the rename commits the destination is the
 * LIVE address -- so an option set in that window belongs to the destination and
 * wins, while anything the source holds and the destination does not is still
 * carried across. Overwriting wholesale on the second pass would silently
 * revert a reader's setting to whatever it was before the rename.
 */
function keepDestinationOptions(
  incoming: Record<string, string | boolean>,
  existing: Record<string, string | boolean> | undefined,
): Record<string, string | boolean> {
  return existing ? { ...incoming, ...existing } : incoming
}

/**
 * The one rule a pointer copy must not break: `prompted` only ever moves
 * false -> true, the same invariant `writePersistedSession` holds.
 *
 * It matters because a copy runs TWICE -- once before the rename commits and
 * once after, so a prompt that landed under the old key in between is not lost
 * -- and by the second run the destination may already hold the fresher reading
 * of the same session. Taking the older value wholesale there would tell the
 * next open that a session which has been spoken to never was, and it would
 * re-attach opening context the agent already has.
 */
function keepPrompted(incoming: StoredValue, existing: StoredValue | undefined): StoredValue {
  const from = normalize(incoming)
  const to = normalize(existing)
  if (!from) {
    return incoming
  }
  if (!to || to.id !== from.id) {
    return from
  }
  return { id: from.id, prompted: from.prompted || to.prompted }
}

function withoutKeys<T>(store: Record<string, T>, moves: readonly TabKeyMove[]): Record<string, T> | null {
  const next = { ...store }
  let changed = false
  for (const { from, to } of moves) {
    if (from === to || !(from in next)) {
      continue
    }
    delete next[from]
    changed = true
  }
  return changed ? next : null
}

/**
 * The destination wins for a cadence too, and for the same reason the options
 * have their own rule: after the rename commits the destination is the live
 * address, so a cadence set in that window is the reader's current choice and a
 * second copy pass must not put the old one back over it.
 */
function keepDestinationPresence(incoming: Presence, existing: Presence | undefined): Presence {
  return existing ?? incoming
}

interface MovableStore {
  settingId: string
  keys: (raw: Record<string, unknown>) => string[]
  moved: (raw: Record<string, unknown>, moves: readonly TabKeyMove[]) => Record<string, unknown> | null
  dropped: (raw: Record<string, unknown>, moves: readonly TabKeyMove[]) => Record<string, unknown> | null
}

/** One entry's worth of "this settings row is addressed by a session key". */
function movable<T>(
  settingId: string,
  fromRaw: (raw: Record<string, unknown>) => Record<string, T>,
  toRaw: (store: Record<string, T>) => Record<string, unknown>,
  merge?: (incoming: T, existing: T | undefined) => T,
): MovableStore {
  return {
    settingId,
    keys: (raw) => Object.keys(fromRaw(raw)),
    moved: (raw, moves) => {
      const next = movedEntries(fromRaw(raw), moves, merge)
      return next ? toRaw(next) : null
    },
    dropped: (raw, moves) => {
      const next = withoutKeys(fromRaw(raw), moves)
      return next ? toRaw(next) : null
    },
  }
}

/**
 * Every settings row addressed by a session key, in the order a move touches
 * them.
 *
 * A list rather than a block of code per store, because THIS is the enumeration
 * a move gets wrong. A store added anywhere else and not added here keeps
 * answering under the old key and nothing reports it: the reader sees a setting
 * that quietly reverted to its default. Adding an entry here is the whole change
 * a new key-addressed row should need.
 *
 * ORDER IS LOAD-BEARING, and the pointer is deliberately last. It is what makes
 * a key resolve to a conversation, so a copy interrupted part-way leaves the new
 * key holding supporting state that nothing addresses yet — rather than a
 * resolvable session that lost the settings its reader had chosen. `dropTabKeys`
 * walks the same list backwards, so the pointer is the first thing the old key
 * stops answering with.
 */
const KEY_ADDRESSED_STORES: readonly MovableStore[] = [
  movable(CONFIG_OPTIONS_SETTING_ID, configOptionsStoreFromRaw, (options) => ({ options }), keepDestinationOptions),
  movable(PRESENCE_SETTING_ID, presenceStoreFromRaw, (presence) => ({ presence }), keepDestinationPresence),
  movable(SETTING_ID, storeFromRaw, (sessions) => ({ sessions }), keepPrompted),
]

/**
 * Point every `to` key at what its `from` key currently holds, leaving `from`
 * alone. Idempotent, so a retried rename is free.
 */
export async function copyTabKeys(moves: readonly TabKeyMove[]): Promise<void> {
  if (moves.length === 0) {
    return
  }
  for (const store of KEY_ADDRESSED_STORES) {
    await withSettingLock(store.settingId, () =>
      mutateSettingData(store.settingId, (raw) => store.moved(raw, moves) ?? raw),
    )
  }
}

/** Every key each key-addressed settings row holds, by setting id. */
export async function tabKeysBySetting(): Promise<Map<string, string[]>> {
  const bySetting = new Map<string, string[]>()
  for (const store of KEY_ADDRESSED_STORES) {
    const row = await getSettingImpl(store.settingId)
    bySetting.set(store.settingId, row ? store.keys(row.data) : [])
  }
  return bySetting
}

/** Forget every `from` key. The pointer goes first, mirroring `copyTabKeys`. */
export async function dropTabKeys(moves: readonly TabKeyMove[]): Promise<void> {
  if (moves.length === 0) {
    return
  }
  for (const store of [...KEY_ADDRESSED_STORES].reverse()) {
    await withSettingLock(store.settingId, () =>
      mutateSettingData(store.settingId, (raw) => store.dropped(raw, moves) ?? raw),
    )
  }
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
  // Session cost and rate-limit windows the harness reported alongside the
  // reading — same persistence lifetime as the pair: an opening estimate for
  // a cold open, overwritten by the next live report.
  cost?: { amount: number; currency: string }
  rateLimits?: { status: string; window: string; utilization?: number; resetsAt?: number }[]
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
 * this store's pointer namespace covers — every group-chat thread resolves
 * through the same `agent-tab-sessions` pointer. Null when there is no
 * pointer for this key,
 * or the pointer's session never reported usage before going offline — the
 * same UNKNOWN a session that has never been loaded reports.
 */
export async function readLastKnownUsage(sessionKey: string): Promise<PersistedUsage | null> {
  const pointer = await readPersistedSession(sessionKey)
  return pointer ? readPersistedUsage(pointer.id) : null
}

export async function writePersistedUsage(
  sessionId: string,
  usage: {
    used: number
    size?: number
    cost?: { amount: number; currency: string }
    rateLimits?: { status: string; window: string; utilization?: number; resetsAt?: number }[]
  },
): Promise<void> {
  await withSettingLock(USAGE_SETTING_ID, () =>
    mutateSettingData(USAGE_SETTING_ID, (raw) => {
      const store = usageStoreFromRaw(raw)
      const current = store[sessionId]
      if (
        current &&
        current.used === usage.used &&
        current.size === usage.size &&
        current.cost?.amount === usage.cost?.amount &&
        current.rateLimits === usage.rateLimits
      ) {
        return raw
      }
      const next: UsageStore = {
        ...store,
        [sessionId]: {
          used: usage.used,
          size: usage.size,
          ...(usage.cost ? { cost: usage.cost } : {}),
          ...(usage.rateLimits ? { rateLimits: usage.rateLimits } : {}),
          at: Date.now(),
        },
      }
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
