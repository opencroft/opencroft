import { useEffect, useSyncExternalStore } from 'react'

import {
  loadRecentThreads,
  type RecentView,
  recordRecentThread as recordOnServer,
  removeRecentThread as removeOnServer,
} from '@/app/_authed/(group-chats)/_server/actions'
import { parseRecentThreadIds } from '@/app/_authed/(group-chats)/_shared/recent-threads'

// The signed-in person's Recent as this tab last heard it from the server,
// where it is kept (recent-store.ts). Every surface that opens a thread
// records it (the shared thread assembly does, so the chats page and a space's
// chat panel both count), and the chats page draws it.
//
// Each server call answers with the whole of Recent as it stands afterwards.
// Answers can arrive out of order -- a load started before a record can settle
// after it -- so an answer replaces what is held only when its version is not
// older: every write moves the version on, and an older answer is missing a
// write a newer one has. Versions count one person's writes, so an answer for
// someone else -- another account signed in in this tab -- always replaces.

/** Where a browser kept its own Recent before it moved into the account. */
const LEGACY_STORAGE_KEY = 'opencroft.group-chats.recent'

let held: RecentView | null = null
const listeners = new Set<() => void>()

function take(next: RecentView) {
  if (held && held.userId === next.userId && next.version < held.version) {
    return
  }
  held = next
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

function readLegacyIds(): string[] {
  try {
    return parseRecentThreadIds(window.localStorage.getItem(LEGACY_STORAGE_KEY))
  } catch {
    // Storage switched off or out of reach: there is nothing to bring over.
    return []
  }
}

function clearLegacyIds() {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Out of reach now too; the next load sends the same ids, and adding a
    // thread already in Recent changes nothing.
  }
}

/**
 * Reads Recent again, bringing this browser's own list from before Recent
 * moved into the account along on the first load that finds one. The local
 * list is cleared only once the server has taken it.
 */
export async function loadRecent(): Promise<void> {
  const legacyIds = readLegacyIds()
  take(await loadRecentThreads({ data: { legacyIds } }))
  if (legacyIds.length > 0) {
    clearLegacyIds()
  }
}

/**
 * Records that `threadId` was opened: the server appends it to the end of
 * Recent the first time and leaves it where it is otherwise. A thread this tab
 * already holds in Recent is not sent again.
 */
export function recordRecentThread(threadId: string) {
  if (held?.threads.some((thread) => thread.id === threadId)) {
    return
  }
  recordOnServer({ data: threadId })
    .then(take)
    .catch((error) => console.error('Failed to record the thread in Recent', threadId, error))
}

/** Takes a thread out of Recent, from the close button on its row. */
export function removeRecentThread(threadId: string) {
  removeOnServer({ data: threadId })
    .then(take)
    .catch((error) => console.error('Failed to remove the thread from Recent', threadId, error))
}

/** Recent as last heard; `null` until the first answer, and on the server render. */
export function useHeldRecent(): RecentView | null {
  return useSyncExternalStore(
    subscribe,
    () => held,
    () => null,
  )
}

/** Records the thread on screen in Recent, each time a different one opens. */
export function useRecordRecentThread(threadId: string) {
  useEffect(() => {
    recordRecentThread(threadId)
  }, [threadId])
}
