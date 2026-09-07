import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatDetail } from 'ui/group-chat/group-chat-detail'
import { ScrollPage } from 'ui/layout/scrollpage'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { stopProcessLocal } from '@/app/_authed/(agent)/_server/acp'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import {
  GroupChatRenameDialog,
  GroupChatThreadDeleteDialog,
  GroupChatThreadRenameDialog,
  GroupChatTopicDialog,
} from '@/app/_authed/(group-chats)/_components/group-chat-edit-dialogs'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatMembersDialog } from '@/app/_authed/(group-chats)/_components/group-chat-members-dialog'
import { GroupChatPinsPanel } from '@/app/_authed/(group-chats)/_components/group-chat-pins-panel'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
import { GroupChatThreadTree } from '@/app/_authed/(group-chats)/_components/group-chat-thread-tree'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { threadSessionKey } from '@/app/_authed/(group-chats)/_lib/thread-session-key'
import { EMPTY_THREAD_LAYOUT } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import { useThreadLayout } from '@/app/_authed/(group-chats)/_lib/use-thread-layout'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  getGroupChatThreadLayout,
  getMyGroupChatView,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import { listAgentNodes } from '@/app/_authed/(space)/_server/agents'

// Inside one group chat: its topic, who is taking part, and its threads.
//
// Both reads are membership-gated server-side and refuse identically for a
// non-member and for a chat that does not exist, so a failure here lands on
// `errorComponent` with copy that does not distinguish the two -- see
// `_lib/group-chat-error.ts` for why that matters.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId')({
  loader: async ({ params }) =>
    loadOrRefusal(async () => {
      // Sequential rather than concurrent: if the membership check refuses, the
      // second request is pointless, and firing both would mean two refusals to
      // reconcile instead of one to report.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      const threads = await listGroupChatThreadsView({ data: params.groupChatId })
      // The picker's candidates, the chat's pins, and how its threads are
      // arranged. Loaded here rather than on opening anything so the panel and
      // the actions are usable the moment the screen is: all four are
      // membership-independent once the two reads above have already passed,
      // so none of them can refuse.
      const [directory, agents, pins, layout] = await Promise.all([
        listDirectoryUsersForPicker(),
        listAgentNodes(),
        listMyGroupChatPins({ data: params.groupChatId }),
        getGroupChatThreadLayout({ data: params.groupChatId }),
      ])
      return { chat, threads, directory, agents, pins, layout }
    }),
  component: GroupChatDetailPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatDetailPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const goToList = useCallback(() => navigate({ to: '/group-chats' }), [navigate])
  const onBack = useSafeBack(goToList)
  // Which thread's Delete was chosen — the shared confirm dialog takes over.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [editingTopic, setEditingTopic] = useState(false)
  // Which thread's Rename was chosen. The kit's row reports the id and stops
  // there -- renaming can be refused, so the dialog is where the new title is
  // collected and where a refusal has somewhere to be shown.
  const [renameThreadId, setRenameThreadId] = useState<string | null>(null)

  // The shared session-activity poll, not a second mechanism invented for this
  // screen — one status vocabulary, one source. A thread's
  // sessionKey is exactly the tab key that poll already reports on; nothing
  // about it is group-chat-specific.
  const threads = data.refused ? [] : data.threads
  const { pendingKeys, activeKeys, aliveKeys } = useSessionActivityKeys(threads.length > 0)
  const threadStatusById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof deriveSessionStatus>>()
    for (const t of threads) {
      map.set(t.id, deriveSessionStatus(t.sessionKey, { pending: pendingKeys, active: activeKeys, alive: aliveKeys }))
    }
    return map
  }, [threads, pendingKeys, activeKeys, aliveKeys])

  const goToThread = (threadId: string) =>
    navigate({ to: '/group-chats/$groupChatId/$threadId', params: { groupChatId, threadId } })

  // The arrangement is owned here rather than inside the list, so the list
  // stays presentational and every write goes through one hook, one store and
  // one compare-and-swap guard. A refused write is answered by adopting the
  // arrangement that won, which is state a presentational list cannot hold.
  const { layout, persist } = useThreadLayout(groupChatId, data.refused ? EMPTY_THREAD_LAYOUT : data.layout)
  const threadTree = (
    <GroupChatThreadTree
      threads={threads}
      statusById={threadStatusById}
      layout={layout}
      onChange={persist}
      onSelect={goToThread}
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

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }
  const { chat, directory, agents, pins } = data
  const threadBeingRenamed = threads.find((t: GroupChatThreadEntry) => t.id === renameThreadId)

  return (
    <ScrollPage>
      {/* GroupChatDetail is its own full-height column -- header, a scrolling
          thread area, and a composer pinned under it -- so it goes straight
          into the page frame. It must NOT be wrapped in a scroll container:
          inside one, its height resolves against content rather than the
          viewport, the thread area stops being the thing that scrolls, and the
          composer rides up to sit under the last thread instead of staying at
          the bottom. That is the defect this fixes, and the thread screen next
          door has always done it this way. Its own padding comes from the kit
          component, which is why the wrapper's `p-4` is gone rather than moved
          here. */}
      <GroupChatDetail
        className='min-h-0 flex-1'
        onBack={onBack}
        name={chat.name}
        topic={chat.topic}
        onEditName={() => setRenaming(true)}
        onEditTopic={() => setEditingTopic(true)}
        members={chat.members}
        // The cluster replaces the old "Add member" button entirely: it is
        // both who is taking part and the way to change it. `members` above
        // is still passed because the kit falls back to a read-only cluster
        // when no slot is given, and it should not need this page to know
        // that to stay correct.
        membersSlot={
          <GroupChatMembersDialog
            groupChatId={groupChatId}
            members={chat.members}
            directory={directory}
            agents={agents}
          />
        }
        pins={<GroupChatPinsPanel groupChatId={groupChatId} pins={pins} />}
        threads={threads.length > 0 ? threadTree : undefined}
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
            // The invalidate lives here rather than in the composer: what
            // follows a started thread (reload this route, navigate into it)
            // is this screen's business, and the embedded surface reusing the
            // composer has no route to invalidate.
            onThreadStarted={(threadId) => {
              void router.invalidate().then(() => goToThread(threadId))
            }}
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
    </ScrollPage>
  )
}
