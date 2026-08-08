import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatList } from 'ui/group-chat/group-chat-list'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { CreateGroupChatAction } from '@/app/_authed/(group-chats)/_components/create-group-chat-action'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import { listMyGroupChatsView } from '@/app/_authed/(group-chats)/_server/actions'

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
  const goHome = useCallback(() => navigate({ to: '/' }), [navigate])
  const onBack = useSafeBack(goHome)

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
    </ScrollPage>
  )
}
