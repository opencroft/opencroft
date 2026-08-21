import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatList } from 'ui/group-chat/group-chat-list'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { CreateGroupChatAction } from '@/app/_authed/(group-chats)/_components/create-group-chat-action'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import { deleteMyGroupChat, listMyGroupChatsView } from '@/app/_authed/(group-chats)/_server/actions'

// The group-chat section index. Rendering only — the
// list component comes from the design kit and is not reshaped here; the
// loader hands it exactly the shape it declares.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats')({
  // A refusal comes back as data, not as a throw — see _lib/load-or-refusal.ts.
  loader: async () => loadOrRefusal(async () => ({ chats: await listMyGroupChatsView() })),
  component: GroupChatsPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatsPage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const goHome = useCallback(() => navigate({ to: '/' }), [navigate])
  const onBack = useSafeBack(goHome)

  // Delete confirm. The kit's row calls onDelete immediately; the confirm lives
  // here for the reason the kit states — what is being destroyed, and how much
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

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleteError(undefined)
    setDeleting(true)
    try {
      await deleteMyGroupChat({ data: deleteTarget.id })
      setDeleteTarget(null)
      await router.invalidate()
    } catch (e) {
      setDeleteError(failureMessage(e, 'The group chat could not be deleted.'))
    } finally {
      setDeleting(false)
    }
  }

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }
  const { chats } = data

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <GroupChatList
          chats={chats}
          onBack={onBack}
          onSelect={(id) => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId: id } })}
          onDelete={(id) => {
            const chat = chats.find((c: { id: string }) => c.id === id)
            if (!chat) {
              return
            }
            setDeleteError(undefined)
            setDeleteTarget({ id: chat.id, name: chat.name })
          }}
          action={<CreateGroupChatAction />}
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
      </ScrollContent>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          // Not dismissable while the delete is in flight. Cancel is already
          // disabled in that state, so Escape and an overlay click closing it
          // anyway was the same intent with two ways round it -- and the way
          // round mattered: a failure arriving after the dialog closed would
          // set an error onto something no longer on screen, leaving the
          // person with no delete, no message, and a list that never refreshed.
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
            <span className='font-medium text-foreground'>{deleteTarget?.name}</span> will be removed, along with every
            thread in it — each conversation, its session and the agent process underneath it. This cannot be undone.
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
