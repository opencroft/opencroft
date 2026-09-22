'use client'

import { useEffect, useSyncExternalStore } from 'react'

import { listSessionActivity } from '@/app/_authed/(agent)/_server/acp'

export interface SessionActivityKeys {
  pendingKeys: Set<string>
  activeKeys: Set<string>
  backgroundKeys: Set<string>
  aliveKeys: Set<string>
}

const EMPTY_SNAPSHOT: SessionActivityKeys = {
  pendingKeys: new Set(),
  activeKeys: new Set(),
  backgroundKeys: new Set(),
  aliveKeys: new Set(),
}

const POLL_INTERVAL_MS = 2500

let snapshot: SessionActivityKeys = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()
let retainCount = 0
let timerId: ReturnType<typeof setInterval> | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function poll(): void {
  listSessionActivity()
    .then((result) => {
      if (retainCount === 0) {
        // Torn down while this request was in flight — don't overwrite the
        // reset snapshot or re-notify subscribers of a dead poll.
        return
      }
      snapshot = {
        pendingKeys: new Set(result.pending),
        activeKeys: new Set(result.active),
        backgroundKeys: new Set(result.background),
        aliveKeys: new Set(result.alive),
      }
      emit()
    })
    .catch(() => {
      // Keep the last snapshot on a failed tick; the next tick retries.
    })
}

// Retained while at least one consumer (the sidebar, the full chat list, ...)
// wants the poll running, torn down the moment none do — one
// `listSessionActivity()` interval shared by every consumer instead of one
// per caller.
function retain(): void {
  retainCount += 1
  if (retainCount === 1) {
    poll()
    timerId = setInterval(poll, POLL_INTERVAL_MS)
  }
}

function release(): void {
  retainCount -= 1
  if (retainCount === 0 && timerId !== null) {
    clearInterval(timerId)
    timerId = null
    snapshot = EMPTY_SNAPSHOT
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SessionActivityKeys {
  return snapshot
}

// Each chat list's process-visibility indicator: blocked on someone — a
// permission request or a question (pending), a turn actively running
// (active), or a live agent process at all (alive — a superset of the other
// two, since both imply a process exists). `enabled` is per-consumer — pass `false` when that
// surface has nothing to show a status for (e.g. no sessions yet) — but the
// underlying poll is shared: it runs once no matter how many consumers
// currently want it, and stops the moment none do.
export function useSessionActivityKeys(enabled: boolean): SessionActivityKeys {
  useEffect(() => {
    if (!enabled) {
      return
    }
    retain()
    return release
  }, [enabled])

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}
