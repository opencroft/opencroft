import { createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { ScrollPage } from 'ui/layout/scrollpage'

import { ChatSelectionScope } from '@/app/_authed/(group-chats)/_components/chat-selection-scope'
import { GroupChatDetailScreen } from '@/app/_authed/(group-chats)/_components/group-chat-detail-screen'
import { GroupChatErrorState } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { REACHED_IN_CHAT } from '@/app/_authed/(group-chats)/_lib/thread-levels'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import {
  getGroupChatThreadLayout,
  getMyGroupChatView,
  listDirectoryAgentsForPicker,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

// Inside one group chat: its topic, who is taking part, and its threads.
//
// Both reads are membership-gated server-side and refuse identically for a
// non-member and for a chat that does not exist, so both lead to the chats
// overview alike -- see `_lib/group-chat-error.ts` for why that matters.
//
// The screen itself is GroupChatDetailScreen, shared with the embedded chat
// panel; what is this route's own is loading the data in a loader and turning
// a chosen thread into a navigation.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats/$groupChatId')({
  loader: async ({ params }) => {
    const loaded = await loadOrRefusal(async () => {
      // All at once: each round trip is a full one on a slow link. The
      // membership-gated reads refuse a non-member and a missing chat the same
      // way, so whichever refusal arrives first is the one to report. The
      // picker's candidates, the chat's pins and how its threads are arranged
      // are loaded here rather than on opening anything, so the panel and the
      // actions are usable the moment the screen is.
      const [chat, threads, directory, agents, pins, layout] = await Promise.all([
        getMyGroupChatView({ data: params.groupChatId }),
        listGroupChatThreadsView({ data: { groupChatId: params.groupChatId, list: 'active' } }),
        listDirectoryUsersForPicker(),
        listDirectoryAgentsForPicker(),
        listMyGroupChatPins({ data: params.groupChatId }),
        getGroupChatThreadLayout({ data: { groupChatId: params.groupChatId, list: 'active' } }),
      ])
      return { chat, threads, directory, agents, pins, layout }
    })
    // A chat out of the reader's reach has no screen of its own: the chats
    // overview, as if they had opened it themselves, over this address's
    // entry so Back does not return to it. The replace is stated because a
    // reload in the background (the reader removed while the chat is open)
    // navigates to a redirect with the redirect's own options.
    if (loaded.refused) {
      throw redirect({ to: '/group-chats', replace: true })
    }
    return loaded
  },
  head: ({ loaderData }) => ({
    meta: [{ title: pageTitle(loaderData?.chat.name, 'Chats') }],
  }),
  component: GroupChatDetailPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatDetailPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  // Replacing, not pushing: with nothing in-app under this entry (a deep link)
  // a pushed list would sit on top of this chat, and the list's own Back
  // would pop straight back into it.
  const goToList = useCallback(() => navigate({ to: '/group-chats', replace: true }), [navigate])
  const onBack = useSafeBack(goToList)
  const goToThread = useCallback(
    (threadId: string, at?: { position: number }) =>
      navigate({
        to: '/group-chats/$groupChatId/$threadId',
        params: { groupChatId, threadId },
        search: at ? { at: at.position } : {},
        state: REACHED_IN_CHAT,
      }),
    [navigate, groupChatId],
  )

  return (
    <ChatSelectionScope spaceId={data.chat.spaceId}>
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
          // From md up the chats are on screen beside this chat, with their own
          // Back out of the page; the chat's Back is the way up to them below md.
          showBackFromMd={false}
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
    </ChatSelectionScope>
  )
}
