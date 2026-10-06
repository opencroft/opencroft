// Which chat sessions are waiting, working, holding a queue, or alive, and how
// much context each live one holds: read here and nowhere else, and pushed to
// each signed-in page over the app's event stream instead of being asked for on
// a timer.
//
// Two sources move these, and both report their changes: the agent engine
// (every session opened, dropped, asking, answered, starting or settling a turn,
// starting or ending background work, its queue or its usage reading changing)
// and this host's background-task registry (a task running for a session
// nobody has in memory). Anything else that moved them would need a report of
// its own here, or pushed readers would miss it.

import { agentClient, subscribeEngineActivity } from '@/app/_authed/(agent)/_server/agent-client-instance'
import type { SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import { backgroundWorkSessionKeys } from '@/app/_authed/(background-tasks)/_server/background-work'
import { backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'
import { listMemberSessionKeys } from '@/app/_authed/(group-chats)/_server/model'
import type { LiveContextUsage, SessionActivitySnapshot } from '@/lib/sse-events'

/** Every session's activity on the instance — for a caller that has already decided who may see it. */
export function sessionActivitySets(): SessionActivitySets {
  return {
    pending: new Set(agentClient.awaitingUserSessionKeys()),
    active: new Set(agentClient.activeSessionKeys()),
    background: backgroundWorkSessionKeys(),
    queued: new Set(
      agentClient
        .listSessions()
        .flatMap((meta) => (meta.sessionKey && (meta.queuedMessages ?? 0) > 0 ? [meta.sessionKey] : [])),
    ),
    compacting: new Set(agentClient.compactingSessionKeys()),
    alive: new Set(agentClient.aliveSessionKeys()),
  }
}

/**
 * The context each live session last reported, by key — the same `listSessions`
 * reading `group_chat_list` gives an agent. An offline session is absent: what
 * it held when it stopped is a stored figure, read with the thread list.
 */
function liveContextUsage(): Map<string, LiveContextUsage> {
  const usage = new Map<string, LiveContextUsage>()
  for (const meta of agentClient.listSessions()) {
    if (meta.sessionKey && meta.usage) {
      usage.set(meta.sessionKey, { usedTokens: meta.usage.used, contextLimit: meta.usage.size ?? null })
    }
  }
  return usage
}

/** The activity of the given sessions only, sorted, so equal pictures serialize equally. */
export function sessionActivityWithin(keys: ReadonlySet<string>): SessionActivitySnapshot {
  return activityPicture((key) => keys.has(key))
}

function activityPicture(includes: (sessionKey: string) => boolean): SessionActivitySnapshot {
  const sets = sessionActivitySets()
  const within = (set: ReadonlySet<string>) => [...set].filter(includes).sort()
  const usage = [...liveContextUsage()].filter(([key]) => includes(key)).sort(([a], [b]) => a.localeCompare(b))
  return {
    pending: within(sets.pending),
    active: within(sets.active),
    background: within(sets.background),
    queued: within(sets.queued),
    compacting: within(sets.compacting),
    alive: within(sets.alive),
    usage: Object.fromEntries(usage),
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

// The instance-wide picture, every key included: each person's picture is cut
// from it, so it changes whenever any of theirs could.
function fingerprint(): string {
  return JSON.stringify(activityPicture(() => true))
}

function scheduleFlush(): void {
  if (flushScheduled) {
    return
  }
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    const seen = fingerprint()
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
    lastSeen = fingerprint()
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
