// Which chat sessions are waiting, working, or alive: read here and nowhere
// else, and pushed to each signed-in page over the app's event stream instead
// of being asked for on a timer.
//
// Two sources move these sets, and both report their changes: the agent engine
// (every session opened, dropped, asking, answered, starting or settling a turn,
// starting or ending background work) and this host's background-task registry
// (a task running for a session nobody has in memory). Anything else that moved
// them would need a report of its own here, or pushed readers would miss it.

import { agentClient, subscribeEngineActivity } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { backgroundWorkSessionKeys } from '@/app/_authed/(background-tasks)/_server/background-work'
import { backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'
import { listMemberSessionKeys } from '@/app/_authed/(group-chats)/_server/model'
import type { SessionActivitySnapshot } from '@/lib/sse-events'

export interface SessionActivitySets {
  pending: Set<string>
  active: Set<string>
  background: Set<string>
  alive: Set<string>
}

/** Every session's activity on the instance — for a caller that has already decided who may see it. */
export function sessionActivitySets(): SessionActivitySets {
  return {
    pending: new Set(agentClient.awaitingUserSessionKeys()),
    active: new Set(agentClient.activeSessionKeys()),
    background: backgroundWorkSessionKeys(),
    alive: new Set(agentClient.aliveSessionKeys()),
  }
}

/** The activity of the given sessions only, sorted, so equal pictures serialize equally. */
export function sessionActivityWithin(keys: ReadonlySet<string>): SessionActivitySnapshot {
  const sets = sessionActivitySets()
  const within = (set: Set<string>) => [...set].filter((key) => keys.has(key)).sort()
  return {
    pending: within(sets.pending),
    active: within(sets.active),
    background: within(sets.background),
    alive: within(sets.alive),
  }
}

// ── change notification ──────────────────────────────────────────────────
//
// Both sources report synchronously and often several times for one step (a
// turn starting is a counter write and then its first event), so changes are
// gathered into one pass per tick, and a pass whose sets came out as they were
// — a second turn on an already working session — notifies nobody.

const listeners = new Set<() => void>()
let detachSources: (() => void) | null = null
let flushScheduled = false
let lastSeen: string | null = null

function fingerprint(sets: SessionActivitySets): string {
  const sorted = (set: Set<string>) => [...set].sort()
  return JSON.stringify([sorted(sets.pending), sorted(sets.active), sorted(sets.background), sorted(sets.alive)])
}

function scheduleFlush(): void {
  if (flushScheduled) {
    return
  }
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    const seen = fingerprint(sessionActivitySets())
    if (seen === lastSeen) {
      return
    }
    lastSeen = seen
    for (const listener of listeners) {
      listener()
    }
  }, 0)
}

/** Called once per tick in which any session's activity changed. Returns the unsubscribe. */
export function subscribeSessionActivity(listener: () => void): () => void {
  listeners.add(listener)
  if (!detachSources) {
    lastSeen = fingerprint(sessionActivitySets())
    const fromEngine = subscribeEngineActivity(scheduleFlush)
    const fromTasks = backgroundTasks.subscribeRunningSessionKeys(scheduleFlush)
    detachSources = () => {
      fromEngine()
      fromTasks()
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && detachSources) {
      detachSources()
      detachSources = null
    }
  }
}

/**
 * Push one person's own activity down one event stream: the current picture
 * at once, then again after every change that alters it.
 *
 * Membership is read afresh for each picture, so a thread joined or left
 * counts from the next change on. A picture whose membership read fails —
 * the sign-in expired under a long-lived stream — is not sent. Reads overtaken
 * by a later one are dropped, so an older picture never lands after a newer.
 */
export function streamOwnSessionActivity(
  request: Request,
  send: (activity: SessionActivitySnapshot) => void,
): () => void {
  let latest = 0
  let lastSent: string | null = null
  const refresh = async () => {
    const read = ++latest
    let activity: SessionActivitySnapshot
    try {
      activity = sessionActivityWithin(await listMemberSessionKeys(request))
    } catch {
      return
    }
    const serialized = JSON.stringify(activity)
    if (read !== latest || serialized === lastSent) {
      return
    }
    lastSent = serialized
    send(activity)
  }
  const unsubscribe = subscribeSessionActivity(() => void refresh())
  void refresh()
  return unsubscribe
}
