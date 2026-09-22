import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { ScrollPage } from 'ui/layout/scrollpage'

import { GroupChatDetailScreen } from '@/app/_authed/(group-chats)/_components/group-chat-detail-screen'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import {
  getGroupChatThreadLayout,
  getMyGroupChatView,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import { listAgentNodes } from '@/app/_authed/(space)/_server/agents'
import { pageTitle } from '@/app/_lib/page-title'

// Inside one group chat: its topic, who is taking part, and its threads.
//
// Both reads are membership-gated server-side and refuse identically for a
// non-member and for a chat that does not exist, so a failure here lands on
// `errorComponent` with copy that does not distinguish the two -- see
// `_lib/group-chat-error.ts` for why that matters.
//
// The screen itself is GroupChatDetailScreen, shared with the embedded chat
// panel; what is this route's own is loading the data in a loader and turning
// a chosen thread into a navigation.
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
  head: ({ loaderData }) => ({
    meta: [{ title: pageTitle(loaderData?.refused === false ? loaderData.chat.name : undefined, 'Chats') }],
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
  const goToThread = useCallback(
    (threadId: string) => navigate({ to: '/group-chats/$groupChatId/$threadId', params: { groupChatId, threadId } }),
    [navigate, groupChatId],
  )

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }

  return (
    <ScrollPage>
      {/* Straight into the page frame, never inside a scroll container -- see
          the screen's own note on why. */}
      <GroupChatDetailScreen
        className='min-h-0 flex-1'
        groupChatId={groupChatId}
        chat={data.chat}
        threads={data.threads}
        directory={data.directory}
        agents={data.agents}
        pins={data.pins}
        layout={data.layout}
        onBack={onBack}
        onOpenThread={goToThread}
        // The invalidate lives here rather than in the composer: what follows
        // a started thread (reload this route, navigate into it) is this
        // screen's business, and the embedded surface reusing the screen has
        // no route to invalidate.
        onThreadStarted={(threadId) => {
          void router.invalidate().then(() => goToThread(threadId))
        }}
      />
    </ScrollPage>
  )
}
