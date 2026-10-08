'use client'

import { useSession } from '@opencroft/auth/client'
import { useCallback, useSyncExternalStore } from 'react'

import type { ThreadList } from '@/app/_authed/(group-chats)/_server/thread-layout-store'

// Whether each folder of a thread list is open, as this person last left it.
//
// The folders themselves are shared by everyone in the chat; whether one is
// open is not. So it lives in the browser, under a key that names the person,
// the chat and the list, and one member collapsing a folder changes nothing for
// anyone else. A folder with no entry is one this person never toggled, and
// the list draws it at its default.

/** Folder id to open, for the folders this person has toggled. */
export type FolderOpenById = Readonly<Record<string, boolean>>

const NOTHING_TOGGLED: FolderOpenById = {}

export function folderOpenKey(userId: string, groupChatId: string, list: ThreadList): string {
  return `opencroft.groupChat.folderOpen.${userId}.${groupChatId}.${list}`
}

// Writes from this tab. Another tab's writes arrive as `storage` events.
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

// The parsed value per key, kept while the stored text is unchanged: a
// snapshot has to be the same object until the value really changes, or every
// read would look like a change and re-render forever.
const parsedByKey = new Map<string, { raw: string | null; value: FolderOpenById }>()

/** The stored map, or nothing toggled when the entry is missing or unreadable. */
export function readFolderOpen(key: string): FolderOpenById {
  const raw = window.localStorage.getItem(key)
  const cached = parsedByKey.get(key)
  if (cached && cached.raw === raw) {
    return cached.value
  }
  const value = parseFolderOpen(raw)
  parsedByKey.set(key, { raw, value })
  return value
}

function parseFolderOpen(raw: string | null): FolderOpenById {
  if (raw === null) {
    return NOTHING_TOGGLED
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return NOTHING_TOGGLED
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return NOTHING_TOGGLED
  }
}

export function writeFolderOpen(key: string, folderId: string, open: boolean): void {
  window.localStorage.setItem(key, JSON.stringify({ ...readFolderOpen(key), [folderId]: open }))
  for (const listener of listeners) {
    listener()
  }
}

/**
 * The signed-in person's open folders in one thread list, and how to record a
 * toggle.
 *
 * Every list drawing the same chat reads the same entry, so the chat's screen
 * and the dock stay in step. The server render has no browser storage, so it
 * draws the defaults and the stored state follows on hydration. Until the
 * session is known there is nobody to remember for: nothing is read, and a
 * toggle stays on screen without being stored.
 */
export function useFolderOpenCache(
  groupChatId: string,
  list: ThreadList,
): { folderOpen: FolderOpenById; setFolderOpen: (folderId: string, open: boolean) => void } {
  const { data: session } = useSession()
  const userId = session?.user.id
  const key = userId ? folderOpenKey(userId, groupChatId, list) : null
  const folderOpen = useSyncExternalStore(
    subscribe,
    () => (key ? readFolderOpen(key) : NOTHING_TOGGLED),
    () => NOTHING_TOGGLED,
  )
  const setFolderOpen = useCallback(
    (folderId: string, open: boolean) => {
      if (key) {
        writeFolderOpen(key, folderId, open)
      }
    },
    [key],
  )
  return { folderOpen, setFolderOpen }
}
