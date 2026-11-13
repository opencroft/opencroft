'use client'

import { useFolderOpenCache } from '@/app/_authed/(group-chats)/_lib/folder-open-cache'
import { useSavedLayout } from '@/app/_authed/(group-chats)/_lib/use-saved-layout'
import type { ThreadList, VersionedThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'
import { saveGroupChatThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

/**
 * One group chat's thread arrangement: what to draw, and how a change is saved
 * (see `useSavedLayout`). The arrangement is shared by the chat's members;
 * which folders are open is the signed-in person's own (`folderOpen`).
 */
export function useThreadLayout(groupChatId: string, list: ThreadList, loaded: VersionedThreadLayout) {
  const listKey = `${groupChatId}.${list}`
  const { layout, persist } = useSavedLayout(listKey, loaded, (tree, expectedVersion) =>
    saveGroupChatThreadLayout({ data: { groupChatId, list, layout: tree, expectedVersion } }),
  )
  const { folderOpen, setFolderOpen } = useFolderOpenCache(listKey)
  return { layout, persist, folderOpen, setFolderOpen }
}
