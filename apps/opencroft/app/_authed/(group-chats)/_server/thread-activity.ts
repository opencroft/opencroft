// What each group-chat thread's session is doing, for extensions: the session
// states the chat's thread status rings are drawn from (session-activity.ts,
// classified by deriveSessionStatus), the context figure `group_chat_list`
// gives an agent, and the time of the session's last event. Nothing is
// tracked here, and nothing of a transcript is read.

import { db, groupChatThread } from '@opencroft/db'
import type {
  HostGroupChatThread,
  HostThreadActivityPage,
  HostThreadContext,
  HostThreadStatus,
} from '@opencroft/server/chat'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  lastSessionActivity,
  sessionActivitySets,
  subscribeSessionActivity,
} from '@/app/_authed/(agent)/_server/session-activity'
import { deriveSessionStatus, type SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import type { ContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import { subscribeGroupChatChanges } from '@/app/_authed/(group-chats)/_server/chat-changes'
import {
  type MemberPrincipal,
  memberChatIds,
  type SenderThread,
  type SenderThreadWithKey,
  senderThreadsByIds,
  senderThreadWithKey,
  threadContextUsage,
  threadsForReader,
} from '@/app/_authed/(group-chats)/_server/model'

/**
 * A thread's status from its session's activity. Archived wins over whatever
 * its session still does (a turn running when it was archived finishes).
 * Compacting comes next: it always runs inside a turn, so the session reads
 * as working while it lasts. A queue with no turn running reads as idle.
 */
export function threadStatus(sessionKey: string, archived: boolean, sets: SessionActivitySets): HostThreadStatus {
  if (archived) {
    return 'archived'
  }
  if (sets.compacting.has(sessionKey)) {
    return 'compacting'
  }
  const status = deriveSessionStatus(sessionKey, sets)
  return status === 'queued' ? 'idle' : status
}

/** A context reading as the extension API gives it: `asOf` as an ISO time, and no cost or rate limits. */
export function hostThreadContext(usage: ContextUsage | null): HostThreadContext | null {
  return (
    usage && {
      usedTokens: usage.usedTokens,
      contextLimit: usage.contextLimit,
      ...(usage.asOf === undefined ? {} : { asOf: new Date(usage.asOf).toISOString() }),
    }
  )
}

/**
 * The threads with their activity. `sets` is the session picture to classify
 * by, now unless given; `lastAt` the sessions' last activity, read unless
 * given.
 */
async function withActivity(
  rows: readonly SenderThreadWithKey[],
  sets: SessionActivitySets = sessionActivitySets(),
  lastAt?: Map<string, number>,
): Promise<HostGroupChatThread[]> {
  const sessions = rows.map((row) => ({ sessionKey: row.sessionKey, agentNodeId: row.thread.agent.nodeId }))
  const [context, last] = await Promise.all([
    threadContextUsage(sessions),
    lastAt ?? lastSessionActivity(sessions.map((session) => session.sessionKey)),
  ])
  return rows.map(({ thread, sessionKey }) => {
    const at = last.get(sessionKey)
    return {
      ...thread,
      status: threadStatus(sessionKey, thread.archived, sets),
      contextUsage: hostThreadContext(context.get(sessionKey) ?? null),
      lastTurnAt: at === undefined ? null : new Date(at).toISOString(),
    }
  })
}

/** One thread a model call returned, with its activity. */
export async function threadWithActivity(thread: SenderThread): Promise<HostGroupChatThread> {
  const [row] = await withActivity([await senderThreadWithKey(thread.threadId)])
  return row as HostGroupChatThread
}

// ── the list ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Where a thread sits in the list: by last activity, newest first, never-active last, then by id. */
interface ListPosition {
  at: number | null
  id: string
}

function compareListPositions(a: ListPosition, b: ListPosition): number {
  if (a.at !== b.at) {
    if (a.at === null) {
      return 1
    }
    if (b.at === null) {
      return -1
    }
    return b.at - a.at
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function writeCursor(position: ListPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

function readCursor(cursor: string): ListPosition {
  const refused = new Error('"cursor" must be a `nextCursor` that `activity` returned')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw refused
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw refused
  }
  const { at, id } = parsed as Record<string, unknown>
  if (typeof id !== 'string' || !(at === null || (typeof at === 'number' && Number.isFinite(at)))) {
    throw refused
  }
  return { at, id }
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`"limit" must be a whole number from 1 to ${MAX_LIMIT}; got ${limit}`)
  }
  return limit
}

function sinceTime(since: string | undefined): number | undefined {
  if (since === undefined) {
    return undefined
  }
  const at = new Date(since).getTime()
  if (Number.isNaN(at)) {
    throw new Error(`"since" must be an ISO date; got "${since}"`)
  }
  return at
}

export interface ThreadActivityOptions {
  chat?: string
  since?: string
  limit?: number
  cursor?: string
  includeArchived?: boolean
}

/**
 * One page of the threads of the chats `reader` is a member of (or of the one
 * chat named), most recently active first. Every thread's last activity is
 * read to order them; the rest of a row only for the page.
 */
export async function threadActivityPage(
  reader: MemberPrincipal,
  options: ThreadActivityOptions = {},
): Promise<HostThreadActivityPage> {
  const limit = pageLimit(options.limit)
  const since = sinceTime(options.since)
  const after = options.cursor === undefined ? undefined : readCursor(options.cursor)
  const rows = await threadsForReader(reader, { chat: options.chat, includeArchived: options.includeArchived })
  const lastAt = await lastSessionActivity(rows.map((row) => row.sessionKey))
  const listed = rows
    .map((row) => ({ row, position: { at: lastAt.get(row.sessionKey) ?? null, id: row.thread.threadId } }))
    .filter(({ position }) => since === undefined || (position.at !== null && position.at >= since))
    .sort((a, b) => compareListPositions(a.position, b.position))
  const start = after ? listed.findIndex(({ position }) => compareListPositions(position, after) > 0) : 0
  const page = start === -1 ? [] : listed.slice(start, start + limit)
  const last = page.at(-1)
  const more = start !== -1 && start + limit < listed.length
  return {
    threads: await withActivity(
      page.map(({ row }) => row),
      undefined,
      lastAt,
    ),
    nextCursor: more && last ? writeCursor(last.position) : null,
  }
}

// ── change notification ──────────────────────────────────────────────────
//
// One watcher while anyone listens, woken by every session activity change
// and every chat change (an archive, an unarchive or a deletion is the
// latter). A thread is judged on its status and its live context reading:
// last activity moves with every event a session records, and would make every
// streamed reply a change. A thread not seen before is a change; a deleted one
// is dropped without one. Passes run one after another, so a picture is never
// compared against a later one.

interface Subscriber {
  /** Who the subscriber reads as, asked on every change: a call-bound copy refuses once its call has ended. */
  reader: () => Promise<MemberPrincipal>
  deliver: (thread: HostGroupChatThread) => void
}

const subscribers = new Set<Subscriber>()
let stopWatching: (() => void) | null = null

/** What a change is judged on, per thread: its status and its live context reading. */
function judgedStates(
  threads: readonly { id: string; sessionKey: string; archived: boolean }[],
  sets: SessionActivitySets,
  liveUsage: Map<string, { used: number; size?: number }>,
): Map<string, string> {
  return new Map(
    threads.map((thread) => {
      const usage = liveUsage.get(thread.sessionKey)
      const state = [threadStatus(thread.sessionKey, thread.archived, sets), usage?.used ?? null, usage?.size ?? null]
      return [thread.id, JSON.stringify(state)] as const
    }),
  )
}

function liveContextReadings(): Map<string, { used: number; size?: number }> {
  const readings = new Map<string, { used: number; size?: number }>()
  for (const meta of agentClient.listSessions()) {
    if (meta.sessionKey && meta.usage) {
      readings.set(meta.sessionKey, meta.usage)
    }
  }
  return readings
}

async function deliverToReaders(rows: readonly HostGroupChatThread[]): Promise<void> {
  await Promise.all(
    [...subscribers].map(async (subscriber) => {
      let chats: Set<string>
      try {
        chats = await memberChatIds(await subscriber.reader())
      } catch {
        // The reader cannot be named any more (its call ended): nothing for it.
        return
      }
      for (const row of rows) {
        if (chats.has(row.chat.ref)) {
          subscriber.deliver(row)
        }
      }
    }),
  )
}

function watch(): () => void {
  let known = new Map<string, string>()
  let pass: Promise<void> = Promise.resolve()
  // A pass still reading when the last subscriber leaves must not announce to
  // the subscribers of the next watcher, whose own first pass is its baseline.
  let stopped = false
  const judge = async (
    sets: SessionActivitySets,
    liveUsage: Map<string, { used: number; size?: number }>,
    announce: boolean,
  ) => {
    const threads = (
      await db
        .select({
          id: groupChatThread.id,
          sessionKey: groupChatThread.sessionKey,
          archivedAt: groupChatThread.archivedAt,
        })
        .from(groupChatThread)
    ).map((thread) => ({ id: thread.id, sessionKey: thread.sessionKey, archived: thread.archivedAt !== null }))
    const states = judgedStates(threads, sets, liveUsage)
    const changed = [...states].filter(([id, state]) => known.get(id) !== state).map(([id]) => id)
    known = states
    if (!announce || changed.length === 0) {
      return
    }
    const rows = await withActivity(await senderThreadsByIds(changed), sets)
    if (stopped) {
      return
    }
    await deliverToReaders(rows)
  }
  // The picture is taken when the change is reported, not when its pass gets
  // to run: a later one read after a wait would fold two changes into one, and
  // a baseline read late would already hold the first change it should report.
  const next = (announce: boolean) => {
    const sets = sessionActivitySets()
    const liveUsage = liveContextReadings()
    pass = pass
      .then(() => judge(sets, liveUsage, announce))
      .catch((error: unknown) => {
        console.error('[thread-activity] reading a change failed', error)
      })
  }
  next(false)
  const fromSessions = subscribeSessionActivity(() => next(true))
  const fromChats = subscribeGroupChatChanges(() => next(true))
  return () => {
    stopped = true
    fromSessions()
    fromChats()
  }
}

/**
 * Called with a thread's row each time its status or live context reading
 * changes, or it appears, for the threads of chats `reader` is a member of at
 * that moment. A listener is extension code: each call gets its own copy, runs
 * after the pass that found the change, and a throw or rejection is logged
 * without reaching the other listeners. Returns the unsubscribe.
 */
export function subscribeThreadActivity(
  reader: () => Promise<MemberPrincipal>,
  listener: (thread: HostGroupChatThread) => void | Promise<void>,
): () => void {
  const subscriber: Subscriber = {
    reader,
    deliver: (thread) => {
      void Promise.resolve()
        .then(() => listener(structuredClone(thread)))
        .catch((error: unknown) => {
          console.error('[thread-activity] a listener failed', error)
        })
    },
  }
  subscribers.add(subscriber)
  stopWatching ??= watch()
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0 && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }
}
