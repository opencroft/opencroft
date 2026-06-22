import { getSetting, upsertSetting } from '@/server/data'

// The user's chat session registry — which conversations exist, their agent/job
// binding and title — stored in the settings table (the data volume) rather than
// per-browser localStorage, so a session created on one device is available on
// every device. The tab→ACP session-id pointers live separately in
// acp-session-store.ts; this is the human-facing list that drives the chat UI.
const SETTING_ID = 'agent-sessions'

export interface SessionEntry {
  key: string
  agentNodeId: string
  agentName: string
  jobNodeId: string
  jobName: string
  title?: string
  createdAt: number
}

export async function readSessions(): Promise<SessionEntry[]> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return []
  }
  const parsed = JSON.parse(row.data) as { sessions?: SessionEntry[] }
  return Array.isArray(parsed.sessions) ? parsed.sessions : []
}

async function writeSessions(list: SessionEntry[]): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify({ sessions: list }))
  notify(list)
}

// In-process pub/sub so the SSE route can push the registry to every connected
// client the moment it changes (no polling). Single server process, so an
// in-memory listener set is enough — every device's EventSource lands here.
type Listener = (list: SessionEntry[]) => void
const listeners = new Set<Listener>()

export function subscribeSessions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(list: SessionEntry[]): void {
  for (const listener of listeners) {
    try {
      listener(list)
    } catch {}
  }
}

// Insert or merge a single session by key. A per-entry write (rather than
// replacing the whole list) keeps two devices editing different sessions from
// clobbering each other. Returns the updated list so the caller can sync state.
export async function upsertSession(entry: Partial<SessionEntry> & { key: string }): Promise<SessionEntry[]> {
  const list = await readSessions()
  const idx = list.findIndex((s) => s.key === entry.key)
  if (idx === -1) {
    list.push(entry as SessionEntry)
  } else {
    list[idx] = { ...list[idx], ...entry }
  }
  await writeSessions(list)
  return list
}

export async function deleteSession(key: string): Promise<SessionEntry[]> {
  const list = await readSessions()
  const next = list.filter((s) => s.key !== key)
  if (next.length !== list.length) {
    await writeSessions(next)
  }
  return next
}
