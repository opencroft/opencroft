import { useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatList, type GroupChatListItem } from 'ui/group-chat/group-chat-list'
import { RecentThreads, recentThreadLeaf } from 'ui/group-chat/recent-threads'

import { useSessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { CreateGroupChatAction } from '@/app/_authed/(group-chats)/_components/create-group-chat-action'
import { GroupChatRenameDialog } from '@/app/_authed/(group-chats)/_components/group-chat-edit-dialogs'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { removeRecentThread } from '@/app/_authed/(group-chats)/_lib/recent-threads-store'
import { threadRowState } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { layoutToNodes } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import { useRecentThreads } from '@/app/_authed/(group-chats)/_lib/use-recent-threads'
import type { GroupChatListEntry, RecentThreadView } from '@/app/_authed/(group-chats)/_server/actions'
import { deleteMyGroupChat } from '@/app/_authed/(group-chats)/_server/actions'

/** The chats page's left panel, as GroupChatsShell takes it. */
export interface GroupChatsSidebarParts {
  chats: React.ReactNode
  recent: React.ReactNode
  dialogs: React.ReactNode
}

// The spaces' own chats under Channels, in their spaces' name order, then the
// chats that are no space's. Channels is listed even with no space chat in it,
// because its heading carries the plus that creates a chat.
const CHANNELS = { id: 'channels', name: 'Channels' }

function listItems(chats: GroupChatListEntry[]): GroupChatListItem[] {
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
  return [...chats]
    .sort((a, b) => {
      if (a.space && b.space) {
        return byName(a.space.name, b.space.name) || byName(a.name, b.name)
      }
      if (a.space || b.space) {
        return a.space ? -1 : 1
      }
      return byName(a.name, b.name)
    })
    .map((chat) => ({
      id: chat.id,
      name: chat.name,
      members: chat.members,
      threadCount: chat.threadCount,
      ...(chat.space ? { group: CHANNELS } : {}),
    }))
}

/**
 * The chats and Recent, with the row menu's rename and delete dialogs. The
 * page decides where each goes; this owns what they show and do.
 *
 * `refreshKey` changes whenever the page's data is read again (a chat or a
 * thread deleted, renamed or started), so Recent asks the server again too and
 * drops a thread deleted meanwhile.
 */
export function useGroupChatsSidebar({
  chats,
  activeChatId,
  activeThreadId,
  refreshKey,
  onOpenChat,
  onOpenRecent,
  onDeletedOpenChat,
}: {
  chats: GroupChatListEntry[]
  activeChatId?: string
  activeThreadId?: string
  refreshKey: unknown
  onOpenChat: (groupChatId: string) => void
  onOpenRecent: (thread: RecentThreadView) => void
  onDeletedOpenChat: () => void
}): GroupChatsSidebarParts {
  const router = useRouter()
  const items = useMemo(() => listItems(chats), [chats])
  const recent = useRecentThreads(refreshKey, activeThreadId)
  // Each row's status and context, from the same pushed session activity a
  // chat's thread list reads, so a thread says the same thing in both places.
  const activity = useSessionActivity()
  const recentNodes = useMemo(
    () =>
      layoutToNodes(
        recent.layout,
        recent.threads.map((thread) => recentThreadLeaf({ ...thread, ...threadRowState(thread, activity) })),
        recent.folderOpen,
      ),
    [recent.layout, recent.threads, recent.folderOpen, activity],
  )

  // Delete confirm. The kit's row calls onDelete immediately; the confirm lives
  // here for the reason the kit states -- what is being destroyed, and how much
  // of it, is the host's knowledge. Same shape as the thread delete on the
  // chat screen, deliberately: one affordance, one flow, at both levels.
  //
  // The target is held as the whole chat rather than its id so the dialog can
  // NAME it. Deleting a container takes its threads and their conversations
  // with it, and a confirmation that does not say which one is being deleted is
  // not really a confirmation.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  // Rename, from the same row menu: a chat's own screen carries no editable
  // title. The dialog refreshes through the group-chat refresh context, which
  // on this page is the router's invalidate.
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleteError(undefined)
    setDeleting(true)
    try {
      await deleteMyGroupChat({ data: deleteTarget.id })
      if (deleteTarget.id === activeChatId) {
        onDeletedOpenChat()
      }
      setDeleteTarget(null)
      await router.invalidate()
    } catch (e) {
      setDeleteError(failureMessage(e, 'The group chat could not be deleted.'))
    } finally {
      setDeleting(false)
    }
  }

  const findChat = (id: string) => chats.find((chat) => chat.id === id)

  return {
    chats: (
      <GroupChatList
        chats={items}
        activeId={activeChatId}
        groups={[{ ...CHANNELS, action: <CreateGroupChatAction /> }]}
        onSelect={onOpenChat}
        onDelete={(id) => {
          const chat = findChat(id)
          if (chat) {
            setDeleteError(undefined)
            setDeleteTarget({ id: chat.id, name: chat.name })
          }
        }}
        onRename={(id) => {
          const chat = findChat(id)
          if (chat) {
            setRenameTarget({ id: chat.id, name: chat.name })
          }
        }}
        emptyState={
          <Empty className='py-12'>
            <EmptyHeader>
              <EmptyTitle>No group chats yet</EmptyTitle>
              <EmptyDescription>
                A group chat gathers a topic's threads, each one a conversation with an agent.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    ),
    recent: (
      <RecentThreads
        nodes={recentNodes}
        activeId={activeThreadId}
        onSelect={(id) => {
          const thread = recent.threads.find((entry) => entry.id === id)
          if (thread) {
            onOpenRecent(thread)
          }
        }}
        onRemove={removeRecentThread}
        onChange={recent.persist}
        onFolderOpenChange={recent.setFolderOpen}
      />
    ),
    dialogs: (
      <>
        {/* Keyed on the chat id so the draft is seeded from the row actually
            chosen rather than from a previously mounted dialog's state. */}
        {renameTarget ? (
          <GroupChatRenameDialog
            key={renameTarget.id}
            open
            onOpenChange={(next) => {
              if (!next) {
                setRenameTarget(null)
              }
            }}
            groupChatId={renameTarget.id}
            name={renameTarget.name}
          />
        ) : null}

        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(next) => {
            // Not dismissable while the delete is in flight: a failure arriving
            // after the dialog closed would set an error onto something no
            // longer on screen, leaving no delete, no message, and a list that
            // never refreshed.
            if (!next && !deleting) {
              setDeleteTarget(null)
              setDeleteError(undefined)
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete group chat</DialogTitle>
            </DialogHeader>
            <p className='text-sm text-muted-foreground'>
              <span className='font-medium text-foreground'>{deleteTarget?.name}</span> will be removed, along with
              every thread in it — each conversation, its session and the agent process underneath it. This cannot be
              undone.
            </p>
            {deleteError ? <p className='text-sm text-destructive'>{deleteError}</p> : null}
            <div className='flex justify-end gap-2'>
              <Button variant='outline' onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant='destructive' onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    ),
  }
}
