'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * The apps this browser opened, most recent first, the open one included: ids
 * of space App instances, across every space. Kept in this browser only,
 * because it is where this reader's hands have been, not a fact about the
 * spaces.
 */
const KEY = 'opencroft:recent-apps'
const LIMIT = 12
const EMPTY: string[] = []

const listeners = new Set<() => void>()
let cache: string[] | null = null

function read(): string[] {
  if (cache) {
    return cache
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    cache = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    cache = []
  }
  return cache
}

function record(id: string) {
  const current = read()
  if (current[0] === id) {
    return
  }
  cache = [id, ...current.filter((other) => other !== id)].slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // A full or blocked storage keeps the history for this page's life only.
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The recent app ids, most recent first; empty on the server. */
export function useRecentApps(): string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

/** Puts the open app at the front of the history whenever another one opens. */
export function useRecordRecentApp(activeAppId: string | undefined) {
  useEffect(() => {
    if (activeAppId) {
      record(activeAppId)
    }
  }, [activeAppId])
}
