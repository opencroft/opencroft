import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatDetail } from 'ui/group-chat/group-chat-detail'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { GroupChatErrorState } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { getMyGroupChatView, listGroupChatThreadsView } from '@/app/_authed/(group-chats)/_server/actions'

// Inside one group chat: its topic, who is taking part, and its threads.
//
// Both reads are membership-gated server-side and refuse identically for a
// non-member and for a chat that does not exist, so a failure here lands on
// `errorComponent` with copy that does not distinguish the two — see
// `_lib/group-chat-error.ts` for why that matters.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId')({
  loader: async ({ params }) => {
    // Sequential rather than concurrent: if the membership check refuses, the
    // second request is pointless, and firing both would mean two refusals to
    // reconcile instead of one to report.
    const chat = await getMyGroupChatView({ data: params.groupChatId })
    const threads = await listGroupChatThreadsView({ data: params.groupChatId })
    return { chat, threads }
  },
  component: GroupChatDetailPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatDetailPage() {
  const { chat, threads } = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <GroupChatDetail
          topic={chat.topic}
          members={chat.members}
          threads={
            threads.length > 0 ? (
              <GroupChatThreadList
                threads={threads}
                onSelect={(threadId) =>
                  navigate({
                    to: '/group-chats/$groupChatId/$threadId',
                    params: { groupChatId, threadId },
                  })
                }
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
        />
      </ScrollContent>
    </ScrollPage>
  )
}
