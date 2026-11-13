// What each agent is doing, gathered over its group-chat threads: the same
// session activity the chat's thread status rings are drawn from
// (session-activity.ts, classified by deriveSessionStatus), bound to agents by
// the threads' own rows. Nothing is tracked here; a thread the chat shows
// working is what makes its agent working.

import { db, groupChatThread } from '@opencroft/db'
import type { HostAgentPresence } from '@opencroft/server/people'

import {
  lastSessionActivity,
  sessionActivitySets,
  subscribeSessionActivity,
} from '@/app/_authed/(agent)/_server/session-activity'
import { deriveSessionStatus, type SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import { listAgentDirectory } from '@/app/_authed/(space)/_server/agents-impl'

export type AgentPresence = HostAgentPresence

/** A thread's session, and the agent it is addressed to. */
export interface ThreadBinding {
  sessionKey: string
  agentNodeId: string
}

/** An agent's presence without its last activity, which costs a read: the part a change is judged on. */
export type AgentState = Pick<AgentPresence, 'agentNodeId' | 'status' | 'activeThreads'>

/**
 * Each agent's state from its threads' sessions, each thread classified as
 * the chat classifies it (deriveSessionStatus). A thread is active while a
 * turn, its background work or a compaction is in flight, a turn waiting on a
 * person included. The agent takes the first of these that any thread is in:
 * `waiting` (a turn blocked on a person, as the chat's Waiting), `working` (an
 * active thread that is not compacting), `compacting` (every active thread is
 * compacting), `idle` (a live session and nothing active), else `offline`.
 * Waiting comes first for the reason it does per thread: it is the one state
 * that needs someone.
 */
export function agentStates(
  agentNodeIds: readonly string[],
  threads: readonly ThreadBinding[],
  sets: SessionActivitySets,
): AgentState[] {
  const keysByAgent = new Map<string, string[]>()
  for (const thread of threads) {
    keysByAgent.set(thread.agentNodeId, [...(keysByAgent.get(thread.agentNodeId) ?? []), thread.sessionKey])
  }
  return agentNodeIds.map((agentNodeId) => {
    let activeThreads = 0
    let waiting = false
    let working = false
    let alive = false
    for (const key of keysByAgent.get(agentNodeId) ?? []) {
      const status = deriveSessionStatus(key, sets)
      const compacting = sets.compacting.has(key)
      if (status === 'working' || status === 'waiting' || compacting) {
        activeThreads += 1
        waiting ||= status === 'waiting'
        working ||= !compacting
      }
      alive ||= status !== 'offline'
    }
    const status = waiting
      ? 'waiting'
      : working
        ? 'working'
        : activeThreads > 0
          ? 'compacting'
          : alive
            ? 'idle'
            : 'offline'
    return { agentNodeId, status, activeThreads }
  })
}

async function threadBindings(): Promise<ThreadBinding[]> {
  return db
    .select({ sessionKey: groupChatThread.sessionKey, agentNodeId: groupChatThread.agentNodeId })
    .from(groupChatThread)
}

/**
 * When each of `threads`' agents last did anything: the latest of its threads'
 * last recorded events and, for a session alive now, the engine's own time of
 * its last event, which the record trails by a write.
 */
async function lastActivity(threads: readonly ThreadBinding[]): Promise<Map<string, number>> {
  const bySession = await lastSessionActivity(threads.map((thread) => thread.sessionKey))
  const latest = new Map<string, number>()
  for (const thread of threads) {
    const at = bySession.get(thread.sessionKey)
    if (at !== undefined && at > (latest.get(thread.agentNodeId) ?? Number.NEGATIVE_INFINITY)) {
      latest.set(thread.agentNodeId, at)
    }
  }
  return latest
}

async function withLastActivity(
  states: readonly AgentState[],
  threads: readonly ThreadBinding[],
): Promise<AgentPresence[]> {
  const wanted = new Set(states.map((state) => state.agentNodeId))
  const latest = await lastActivity(threads.filter((thread) => wanted.has(thread.agentNodeId)))
  return states.map((state) => {
    const at = latest.get(state.agentNodeId)
    return { ...state, lastActiveAt: at === undefined ? null : new Date(at).toISOString() }
  })
}

/** Every agent of the agent directory, in its order (by name), with its presence. */
export async function listAgentPresence(): Promise<AgentPresence[]> {
  const [agents, threads] = await Promise.all([listAgentDirectory(), threadBindings()])
  const states = agentStates(
    agents.map((agent) => agent.id),
    threads,
    sessionActivitySets(),
  )
  return withLastActivity(states, threads)
}

// ── change notification ──────────────────────────────────────────────────
//
// One watcher of the session activity while anyone listens. A change is
// judged on status and active threads only: last activity moves with every
// event a session records, and would make every streamed reply a change.
// Passes run one after another, so a picture is never compared against a
// later one.

const listeners = new Set<(presence: AgentPresence) => void>()
let stopWatching: (() => void) | null = null

function watch(): () => void {
  let known = new Map<string, AgentState>()
  let pass: Promise<void> = Promise.resolve()
  // A pass still reading when the last listener leaves must not announce to
  // the listeners of the next watcher, whose own first pass is its baseline.
  let stopped = false
  const judge = async (picture: SessionActivitySets, announce: boolean) => {
    const threads = await threadBindings()
    const agentNodeIds = [...new Set(threads.map((thread) => thread.agentNodeId))]
    const states = agentStates(agentNodeIds, threads, picture)
    const changed = states.filter((state) => {
      const before = known.get(state.agentNodeId)
      return (before?.status ?? 'offline') !== state.status || (before?.activeThreads ?? 0) !== state.activeThreads
    })
    known = new Map(states.map((state) => [state.agentNodeId, state]))
    if (!announce || changed.length === 0) {
      return
    }
    // The threads of an agent whose node was deleted keep their rows; the
    // directory does not list that agent, and neither does this.
    const listed = new Set((await listAgentDirectory()).map((agent) => agent.id))
    const rows = await withLastActivity(
      changed.filter((state) => listed.has(state.agentNodeId)),
      threads,
    )
    if (stopped) {
      return
    }
    for (const row of rows) {
      for (const listener of listeners) {
        listener(row)
      }
    }
  }
  // The picture is taken when the change is reported, not when its pass gets
  // to run: a later one read after a wait would fold two changes into one, and
  // a baseline read late would already hold the first change it should report.
  const next = (announce: boolean) => {
    const picture = sessionActivitySets()
    pass = pass
      .then(() => judge(picture, announce))
      .catch((error: unknown) => {
        console.error('[agent-presence] reading a change failed', error)
      })
  }
  next(false)
  const unsubscribe = subscribeSessionActivity(() => next(true))
  return () => {
    stopped = true
    unsubscribe()
  }
}

/**
 * Called with an agent's presence each time its status or its number of
 * active threads changes. A listener is extension code: each call gets its own
 * copy, runs after the pass that found the change, and a throw or rejection is
 * logged without reaching the other listeners. Returns the unsubscribe.
 */
export function subscribeAgentPresence(listener: (presence: AgentPresence) => void | Promise<void>): () => void {
  const deliver = (presence: AgentPresence) => {
    void Promise.resolve()
      .then(() => listener({ ...presence }))
      .catch((error: unknown) => {
        console.error('[agent-presence] a listener failed', error)
      })
  }
  listeners.add(deliver)
  stopWatching ??= watch()
  return () => {
    listeners.delete(deliver)
    if (listeners.size === 0 && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }
}
