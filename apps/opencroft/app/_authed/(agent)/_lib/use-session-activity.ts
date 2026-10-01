'use client'

import { useSyncExternalStore } from 'react'

import type { SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import type { LiveContextUsage, SessionActivitySnapshot } from '@/lib/sse-events'

/** A live reading kept past the session's last report, stamped with when that was seen. */
export interface DepartedContextUsage extends LiveContextUsage {
  asOf: number
}

/**
 * The reader's own sessions as the server last pushed them: the activity sets
 * a status is derived from (see deriveSessionStatus), and each live session's
 * context reading by key.
 */
export interface SessionActivity extends SessionActivitySets {
  usage: ReadonlyMap<string, LiveContextUsage>
  /**
   * The last live reading of each session that has since stopped reporting one
   * (reaped, stopped, crashed), as of the picture that first lacked it. A list's
   * stored readings are from when it loaded, so without this a row would fall
   * back past everything the session did while the list was open.
   */
  departedUsage: ReadonlyMap<string, DepartedContextUsage>
}

const EMPTY_SNAPSHOT: SessionActivity = {
  pending: new Set(),
  active: new Set(),
  background: new Set(),
  queued: new Set(),
  alive: new Set(),
  usage: new Map(),
  departedUsage: new Map(),
}

let snapshot: SessionActivity = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

/**
 * The activity after a pushed picture. The sets and live readings are the
 * picture's own; a reading the previous picture had and this one lacks moves
 * to `departedUsage`, stamped `now`, and leaves it again once the session
 * reports afresh.
 */
export function nextSessionActivity(
  previous: SessionActivity,
  activity: SessionActivitySnapshot,
  now: number,
): SessionActivity {
  const usage = new Map(Object.entries(activity.usage))
  const departedUsage = new Map(previous.departedUsage)
  for (const [key, reading] of previous.usage) {
    if (!usage.has(key)) {
      departedUsage.set(key, { ...reading, asOf: now })
    }
  }
  for (const key of usage.keys()) {
    departedUsage.delete(key)
  }
  return {
    pending: new Set(activity.pending),
    active: new Set(activity.active),
    background: new Set(activity.background),
    queued: new Set(activity.queued),
    alive: new Set(activity.alive),
    usage,
    departedUsage,
  }
}

/**
 * Take the picture the server pushed on the page's event stream. Each one is
 * whole (see SessionActivitySnapshot), and every stream opens with one, so a
 * reconnect replaces the sets and live readings rather than patching them.
 * While the stream is down the last picture stays.
 */
export function receiveSessionActivity(activity: SessionActivitySnapshot): void {
  snapshot = nextSessionActivity(snapshot, activity, Date.now())
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SessionActivity {
  return snapshot
}

// Each chat list's process-visibility indicator and context reading. Pushed by
// the server as it changes, so reading it costs no request however many
// surfaces do.
export function useSessionActivity(): SessionActivity {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}
