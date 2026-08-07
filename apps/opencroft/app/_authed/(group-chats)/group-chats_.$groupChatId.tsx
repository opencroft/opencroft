import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatDetail } from 'ui/group-chat/group-chat-detail'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatMembersDialog } from '@/app/_authed/(group-chats)/_components/group-chat-members-dialog'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  deleteGroupChatThread,
  getMyGroupChatView,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
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
      // The picker's candidates. Loaded here rather than on opening the dialog
      // so the actions are usable the moment the screen is: both are small,
      // membership-independent lists, and neither can refuse once the two
      // reads above have already passed.
      const [directory, agents] = await Promise.all([listDirectoryUsersForPicker(), listAgentNodes()])
      return { chat, threads, directory, agents }
    }),
  component: GroupChatDetailPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatDetailPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  // Delete confirm. The kit's ChatListItem calls onDelete immediately; the
  // confirm lives here rather than in the kit because whether to confirm (and
  // with what copy) is a product call, and the kit is agnostic to it.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()

  const goToThread = (threadId: string) =>
    navigate({ to: '/group-chats/$groupChatId/$threadId', params: { groupChatId, threadId } })

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleteError(undefined)
    setDeleting(true)
    try {
      await deleteGroupChatThread({ data: deleteTarget })
      setDeleteTarget(null)
      await router.invalidate()
    } catch (e) {
      setDeleteError(failureMessage(e, 'The thread could not be deleted.'))
    } finally {
      setDeleting(false)
    }
  }

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }
  const { chat, threads, directory, agents } = data

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <GroupChatDetail
          topic={chat.topic}
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
          threads={
            threads.length > 0 ? (
              <GroupChatThreadList
                // `agentIsMember` is the server's fact; `disabled` is what this
                // screen does with it. The mapping lives here rather than in
                // the read model so a server type never carries a CSS state.
                threads={threads.map((t: GroupChatThreadEntry) => ({ ...t, disabled: !t.agentIsMember }))}
                onSelect={(threadId) => goToThread(threadId)}
                onDelete={(threadId) => {
                  setDeleteError(undefined)
                  setDeleteTarget(threadId)
                }}
              />
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
              onThreadStarted={goToThread}
            />
          }
        />
      </ScrollContent>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null)
            setDeleteError(undefined)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete thread</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>
            The conversation, its session and the agent process underneath it will be removed. This cannot be undone.
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
    </ScrollPage>
  )
}
