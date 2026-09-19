'use client'

// Inside one group chat: its topic, who is taking part, its pinned notes, its
// threads and the composer that starts one. The screen the group-chat route
// draws -- and, since the embedded chat gained the same two windows, the one
// a space canvas or an extension view draws inside its chat panel before a
// thread is open.
//
// One component for both because they were one screen: the route used to hold
// all of this inline, and the embedded surface offered a bare "New chat"
// composer in its place, which is how the panel came to have no pins, no thread
// list and no way to rename anything. The data arrives as props -- the route
// loads it in its loader, the embedded panel loads it itself -- and every write
// refreshes through the group-chat refresh context, which is what lets the
// dialogs and panels inside work the same on both hosts.

import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatDetail } from 'ui/group-chat/group-chat-detail'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { Input } from 'ui/input'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { stopProcessLocal } from '@/app/_authed/(agent)/_server/acp'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import {
  GroupChatRenameDialog,
  GroupChatThreadDeleteDialog,
  GroupChatThreadRenameDialog,
  GroupChatTopicDialog,
} from '@/app/_authed/(group-chats)/_components/group-chat-edit-dialogs'
import { GroupChatMembersDialog } from '@/app/_authed/(group-chats)/_components/group-chat-members-dialog'
import { GroupChatPinsPanel } from '@/app/_authed/(group-chats)/_components/group-chat-pins-panel'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
import { GroupChatThreadTree } from '@/app/_authed/(group-chats)/_components/group-chat-thread-tree'
import { threadSessionKey } from '@/app/_authed/(group-chats)/_lib/thread-session-key'
import { useThreadLayout } from '@/app/_authed/(group-chats)/_lib/use-thread-layout'
import type {
  getGroupChatThreadLayout,
  getMyGroupChatView,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { listAgentNodes } from '@/app/_authed/(space)/_server/agents'

/** Everything the screen draws, in the shape the server functions answer with. */
export interface GroupChatDetailData {
  chat: Awaited<ReturnType<typeof getMyGroupChatView>>
  threads: Awaited<ReturnType<typeof listGroupChatThreadsView>>
  directory: Awaited<ReturnType<typeof listDirectoryUsersForPicker>>
  agents: Awaited<ReturnType<typeof listAgentNodes>>
  pins: Awaited<ReturnType<typeof listMyGroupChatPins>>
  layout: Awaited<ReturnType<typeof getGroupChatThreadLayout>>
}

export interface GroupChatDetailScreenProps extends GroupChatDetailData {
  groupChatId: string
  /** The back affordance, when this screen nests inside something. */
  onBack?: () => void
  /** A thread row was chosen. */
  onOpenThread: (threadId: string) => void
  /** The composer started a thread. The host decides what follows -- the
   *  route reloads and navigates, the embedded panel opens it in place. */
  onThreadStarted: (threadId: string) => void
  /** The thread the reader is in, when the screen is drawn beside one. */
  activeThreadId?: string
  className?: string
}

export function GroupChatDetailScreen({
  groupChatId,
  chat,
  threads,
  directory,
  agents,
  pins,
  layout: loadedLayout,
  onBack,
  onOpenThread,
  onThreadStarted,
  activeThreadId,
  className,
}: GroupChatDetailScreenProps) {
  // Which thread's Delete was chosen — the shared confirm dialog takes over.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [editingTopic, setEditingTopic] = useState(false)
  // Which thread's Rename was chosen. The kit's row reports the id and stops
  // there -- renaming can be refused, so the dialog is where the new title is
  // collected and where a refusal has somewhere to be shown.
  const [renameThreadId, setRenameThreadId] = useState<string | null>(null)
  // The thread search: a header button opens a field over the list, and a
  // query narrows the threads to the ones whose title or agent matches. It
  // replaced the chat panel's "Choose a chat" menu, whose search was the one
  // part of it worth keeping -- and it lives here, on the screen that lists
  // the threads, rather than in a popover beside it.
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  // The shared session-activity poll, not a second mechanism invented for this
  // screen — one status vocabulary, one source. A thread's sessionKey is
  // exactly the tab key that poll already reports on; nothing about it is
  // group-chat-specific.
  const { pendingKeys, activeKeys, backgroundKeys, aliveKeys } = useSessionActivityKeys(threads.length > 0)
  const threadStatusById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof deriveSessionStatus>>()
    for (const t of threads) {
      map.set(
        t.id,
        deriveSessionStatus(t.sessionKey, {
          pending: pendingKeys,
          active: activeKeys,
          background: backgroundKeys,
          alive: aliveKeys,
        }),
      )
    }
    return map
  }, [threads, pendingKeys, activeKeys, backgroundKeys, aliveKeys])

  // The arrangement is owned here rather than inside the list, so the list
  // stays presentational and every write goes through one hook, one store and
  // one compare-and-swap guard. A refused write is answered by adopting the
  // arrangement that won, which is state a presentational list cannot hold.
  const { layout, persist } = useThreadLayout(groupChatId, loadedLayout)
  const threadTree = (
    <GroupChatThreadTree
      threads={threads}
      statusById={threadStatusById}
      layout={layout}
      onChange={persist}
      activeId={activeThreadId}
      onSelect={onOpenThread}
      // The kit hands back the row id -- the THREAD id, not the session key
      // this has to act on. That split is deliberate on its side (the kit knows
      // nothing about session keys) and the mapping is already here:
      // `sessionKey` rides on every list entry.
      //
      // Same server fn the sidebar chat list's own Stop process calls, so there
      // is one way to stop a process, not two. Nothing is invalidated
      // afterwards: the row's state comes from the shared activity poll, which
      // reports the process gone on its next tick.
      onStopProcess={(threadId) => {
        const sessionKey = threadSessionKey(threads, threadId)
        if (!sessionKey) {
          return
        }
        stopProcessLocal({ data: sessionKey }).catch((err) => {
          console.error('Failed to stop thread process', threadId, err)
        })
      }}
      onRename={(threadId) => setRenameThreadId(threadId)}
      onDelete={(threadId) => setDeleteTarget(threadId)}
    />
  )

  // A query is answered with a FLAT list, newest first, not the tree: folders
  // arrange threads, and a search is a question about names that cuts across
  // any arrangement. Same rows the tree draws, same context menu behind them.
  const trimmedQuery = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!trimmedQuery) {
      return []
    }
    return [...threads]
      .filter(
        (t) =>
          (t.title ?? '').toLowerCase().includes(trimmedQuery) || t.agent.name.toLowerCase().includes(trimmedQuery),
      )
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .map((t) => ({
        id: t.id,
        title: t.title,
        agent: t.agent,
        createdAt: new Date(t.createdAt),
        disabled: !t.agentIsMember,
        status: threadStatusById.get(t.id),
        hasDraft: t.hasDraft,
      }))
  }, [threads, trimmedQuery, threadStatusById])
  const closeSearch = () => {
    setSearching(false)
    setQuery('')
  }
  const searchField = searching ? (
    <div className='mb-2 flex items-center gap-1'>
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            closeSearch()
          }
        }}
        placeholder='Search threads…'
        className='h-8'
      />
      <Button type='button' variant='ghost' size='icon-sm' aria-label='Close search' onClick={closeSearch}>
        <X />
      </Button>
    </div>
  ) : null
  const threadArea = trimmedQuery ? (
    matches.length > 0 ? (
      <GroupChatThreadList
        threads={matches}
        activeId={activeThreadId}
        onSelect={onOpenThread}
        onRename={(threadId) => setRenameThreadId(threadId)}
        onStopProcess={(threadId) => {
          const sessionKey = threadSessionKey(threads, threadId)
          if (sessionKey) {
            stopProcessLocal({ data: sessionKey }).catch((err) => {
              console.error('Failed to stop thread process', threadId, err)
            })
          }
        }}
        onDelete={(threadId) => setDeleteTarget(threadId)}
      />
    ) : (
      <p className='px-1 py-2 text-sm text-muted-foreground'>No threads match the search.</p>
    )
  ) : threads.length > 0 ? (
    threadTree
  ) : undefined

  const threadBeingRenamed = threads.find((t) => t.id === renameThreadId)

  return (
    <>
      {/* GroupChatDetail is its own full-height column -- header, a scrolling
          thread area, and a composer pinned under it -- so it goes straight
          into whatever frame holds it. It must NOT be wrapped in a scroll
          container: inside one, its height resolves against content rather
          than the viewport, the thread area stops being the thing that
          scrolls, and the composer rides up to sit under the last thread
          instead of staying at the bottom. */}
      <GroupChatDetail
        className={className}
        onBack={onBack}
        name={chat.name}
        topic={chat.topic}
        onEditName={() => setRenaming(true)}
        onEditTopic={() => setEditingTopic(true)}
        members={chat.members}
        // The cluster replaces the old "Add member" button entirely: it is
        // both who is taking part and the way to change it. `members` above
        // is still passed because the kit falls back to a read-only cluster
        // when no slot is given, and it should not need this screen to know
        // that to stay correct.
        membersSlot={
          <GroupChatMembersDialog
            groupChatId={groupChatId}
            members={chat.members}
            directory={directory}
            agents={agents}
          />
        }
        actions={
          threads.length > 0 && !searching ? (
            <Button
              type='button'
              variant='ghost'
              size='icon-sm'
              aria-label='Search threads'
              title='Search threads'
              onClick={() => setSearching(true)}
            >
              <Search />
            </Button>
          ) : undefined
        }
        pins={<GroupChatPinsPanel groupChatId={groupChatId} pins={pins} />}
        threads={
          searchField || threadArea ? (
            <>
              {searchField}
              {threadArea}
            </>
          ) : undefined
        }
        emptyState={
          <Empty className='py-8'>
            <EmptyHeader>
              <EmptyTitle>No threads yet</EmptyTitle>
              <EmptyDescription>
                A group chat holds no messages of its own. Each thread inside it is a conversation with one agent.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        composer={
          <GroupChatStartThreadComposer
            groupChatId={groupChatId}
            members={chat.members}
            onThreadStarted={onThreadStarted}
          />
        }
      />

      <GroupChatRenameDialog open={renaming} onOpenChange={setRenaming} groupChatId={groupChatId} name={chat.name} />
      {/* Keyed on the thread id so the dialog's draft is seeded from the row
          actually chosen -- without it, opening Rename on a second thread would
          reuse the first one's mounted state and offer the wrong title. */}
      {threadBeingRenamed ? (
        <GroupChatThreadRenameDialog
          key={threadBeingRenamed.id}
          open
          onOpenChange={(next) => {
            if (!next) {
              setRenameThreadId(null)
            }
          }}
          threadId={threadBeingRenamed.id}
          title={threadBeingRenamed.title ?? ''}
        />
      ) : null}
      <GroupChatTopicDialog
        open={editingTopic}
        onOpenChange={setEditingTopic}
        groupChatId={groupChatId}
        topic={chat.topic}
      />

      {deleteTarget ? (
        <GroupChatThreadDeleteDialog
          key={deleteTarget}
          open
          onOpenChange={(next) => {
            if (!next) {
              setDeleteTarget(null)
            }
          }}
          threadId={deleteTarget}
        />
      ) : null}
    </>
  )
}
