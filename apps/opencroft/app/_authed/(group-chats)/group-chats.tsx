import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useCallback } from 'react'
import { GroupChatsShell } from 'ui/group-chat/group-chats-shell'

import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { useGroupChatsSidebar } from '@/app/_authed/(group-chats)/_components/group-chats-sidebar'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useOpenThreadWithLevels, useThreadLevelsOnArrival } from '@/app/_authed/(group-chats)/_lib/use-thread-levels'
import { listMyGroupChatsView, type RecentThreadView } from '@/app/_authed/(group-chats)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

// The chats page: the chats and Recent on the left, and on the right whatever
// the address names -- nothing yet, a chat (its own route), or a thread (its
// own route). One page rather than a page per level: this route stays mounted
// while chats and threads open beside it, so the left panel never reloads or
// loses its scroll.
//
// Below md the kit's shell shows one level at a time and each level is its own
// history entry, so the screens' Back and the system Back both go up one.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats')({
  // A refusal comes back as data, not as a throw — see _lib/load-or-refusal.ts.
  loader: async () => loadOrRefusal(async () => ({ chats: await listMyGroupChatsView() })),
  head: () => ({ meta: [{ title: pageTitle('Chats') }] }),
  component: GroupChatsPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatsPage() {
  const data = Route.useLoaderData()
  // The open chat and thread, from whichever child route matched.
  const { groupChatId, threadId } = useParams({ strict: false })
  const navigate = useNavigate()
  // A thread is always reached through its chat's thread list, so Back from
  // it steps up to that list (and below md to the chats list) however it was
  // opened: from Recent, by its address, or by a link elsewhere in the app.
  useThreadLevelsOnArrival()
  const openThread = useOpenThreadWithLevels()

  const openChat = useCallback(
    (id: string) => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId: id } }),
    [navigate],
  )
  const openRecent = useCallback(
    (thread: RecentThreadView) => openThread({ groupChatId: thread.groupChatId, threadId: thread.id }),
    [openThread],
  )

  const sidebar = useGroupChatsSidebar({
    chats: data.refused ? [] : data.chats,
    activeChatId: groupChatId,
    activeThreadId: threadId,
    refreshKey: data,
    onOpenChat: (id) => void openChat(id),
    onOpenRecent: (thread) => void openRecent(thread),
    onDeletedOpenChat: () => void navigate({ to: '/group-chats', replace: true }),
  })

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }

  return (
    <>
      <GroupChatsShell isOpened={groupChatId !== undefined} chats={sidebar.chats} recent={sidebar.recent}>
        <Outlet />
      </GroupChatsShell>
      {sidebar.dialogs}
    </>
  )
}
