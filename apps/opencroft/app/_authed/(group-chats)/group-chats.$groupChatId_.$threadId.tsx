import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { Button } from 'ui/button'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'
import { ScrollPage } from 'ui/layout/scrollpage'

import { useSessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { ChatSelectionScope } from '@/app/_authed/(group-chats)/_components/chat-selection-scope'
import { GroupChatThreadLoadFailed } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatThreadChat } from '@/app/_authed/(group-chats)/_components/group-chat-thread-chat'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { parseRevealPosition } from '@/app/_authed/(group-chats)/_lib/reveal-position'
import { REACHED_IN_CHAT } from '@/app/_authed/(group-chats)/_lib/thread-levels'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import { useSignedInReader } from '@/app/_authed/(group-chats)/_lib/use-signed-in-reader'
import type { GroupChatDetailView, GroupChatThreadView } from '@/app/_authed/(group-chats)/_server/actions'
import {
  findGroupChatThreadInChat,
  getMyGroupChatView,
  listThreadArtifacts,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { ThreadArtifact } from '@/app/_authed/(group-chats)/_server/artifacts'
import { pageTitle } from '@/app/_lib/page-title'

// Reading one thread inside a group chat.
//
// THE CONVERSATION IS NOT REDRAWN HERE. A group-chat thread is an ordinary
// agent session, opened through the same `ensureLocalSessionImpl` a 1:1 chat
// uses and keyed on the thread's `sessionKey`, so this reattaches to that
// session and renders it through GroupChatThreadChat, the one shared assembly
// (session wiring, conversation, approvals, composer) this route shares with
// the extension-embedded chat. What is THIS route's own is
// the frame: the kit's thread framing with its breadcrumbs and the artifact
// strip, supplied through the assembly's `renderFrame` slot.
interface ThreadPageData {
  thread: GroupChatThreadView
  chat: GroupChatDetailView
  artifacts: ThreadArtifact[]
}

// A thread this page cannot show has no screen of its own. Each redirect
// replaces the dead address's entry, so Back does not return to it. The
// replace is stated rather than left to the router: a reload in the
// background (the open thread deleted, or the reader removed from its chat)
// navigates to a redirect with the redirect's own options.
//
// Deleted: the chat's thread list.
function toThreadList(groupChatId: string) {
  return redirect({ to: '/group-chats/$groupChatId', params: { groupChatId }, replace: true })
}
// Out of the reader's reach, the chat included: the chats overview, as if they
// had opened it themselves -- the address says nothing about what is behind it.
function toChats() {
  return redirect({ to: '/group-chats', replace: true })
}

export const Route = createFileRoute('/_authed/(group-chats)/group-chats/$groupChatId_/$threadId')({
  // `?at=` is the turn a message search opened this thread for; absent for
  // every other way in. Not a loader input: the turn is found once the
  // session is open, which the loader cannot wait for.
  validateSearch: (search: Record<string, unknown>): { at?: number } => ({ at: parseRevealPosition(search.at) }),
  // Refusals come back from the reads as data rather than as a throw — see
  // _lib/load-or-refusal.ts for the measurement behind that — and become a
  // redirect here, a router signal like `notFound()`.
  loader: async ({ params }): Promise<ThreadPageData> => {
    const loaded = await loadOrRefusal(async (): Promise<{ page: ThreadPageData | null }> => {
      // Looked for inside the chat the URL names, which checks membership
      // first -- so a deleted thread can be told apart from one the reader
      // may not have, and the answer arrives as data rather than a throw.
      const found = await findGroupChatThreadInChat({
        data: { groupChatId: params.groupChatId, threadId: params.threadId },
      })
      if (found.state === 'gone') {
        throw toThreadList(params.groupChatId)
      }
      if (found.state === 'refused') {
        return { page: null }
      }
      // The framing shows the group chat's name as a breadcrumb, which lives
      // on the group chat rather than the thread.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      const artifacts = await listThreadArtifacts({ data: params.threadId })
      return { page: { thread: found.thread, chat, artifacts } }
    })
    if (loaded.refused || !loaded.page) {
      throw toChats()
    }
    return loaded.page
  },
  // An untitled thread is named by its chat alone rather than by a
  // placeholder -- pageTitle drops it.
  head: ({ loaderData }) => ({
    meta: [{ title: pageTitle(loaderData?.thread.title, loaderData?.chat.name ?? 'Chats') }],
  }),
  component: GroupChatThreadPage,
  errorComponent: ThreadLoadFailed,
})

// What reaches the boundary now is only the unexpected -- the thread's own
// answers come back as data -- so it is the same load-failed state the
// embedded chat shows, and Try again reruns the loader.
function ThreadLoadFailed() {
  const router = useRouter()
  const { groupChatId } = Route.useParams()
  return (
    <GroupChatThreadLoadFailed
      className='py-12'
      onRetry={() => void router.invalidate()}
      action={<BackToThreadList groupChatId={groupChatId} />}
    />
  )
}

// The page's way out of a thread it cannot show, as the dock's Back is the
// dock's: to the chat's thread list, where another thread can be opened.
function BackToThreadList({ groupChatId }: { groupChatId: string }) {
  return (
    <Button
      size='sm'
      variant='outline'
      nativeButton={false}
      render={<Link to='/group-chats/$groupChatId' params={{ groupChatId }} />}
    >
      Back to the thread list
    </Button>
  )
}

function GroupChatThreadPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const { at } = Route.useSearch()
  const navigate = useNavigate()
  // Replacing, not pushing: with nothing in-app under this entry (a deep link)
  // a pushed chat would sit on top of this thread, and the chat's own Back
  // would pop straight back into it.
  const goToChat = useCallback(
    () => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId }, replace: true }),
    [navigate, groupChatId],
  )
  const onBack = useSafeBack(goToChat)
  // Where a fork lands: the server creates the destination thread, this opens
  // it — the reader crosses into the new conversation, whose composer already
  // holds the forked message as its draft. Back from it returns to the thread
  // it was forked from, which is in the same chat.
  const onThreadForked = useCallback(
    (threadId: string) =>
      navigate({
        to: '/group-chats/$groupChatId/$threadId',
        params: { groupChatId, threadId },
        state: REACHED_IN_CHAT,
      }),
    [navigate, groupChatId],
  )
  // The open thread went away: the loader asks again and redirects as it does
  // for an address opened fresh.
  const router = useRouter()
  const onUnavailable = useCallback(() => void router.invalidate(), [router])

  return (
    <ChatSelectionScope spaceId={data.chat.spaceId}>
      <ThreadConversation
        thread={data.thread}
        chat={data.chat}
        artifacts={data.artifacts}
        revealPosition={at}
        onBack={onBack}
        onThreadForked={onThreadForked}
        onUnavailable={onUnavailable}
      />
    </ChatSelectionScope>
  )
}

function ThreadConversation({
  thread,
  chat,
  artifacts: initialArtifacts,
  revealPosition,
  onBack,
  onThreadForked,
  onUnavailable,
}: {
  artifacts: ThreadArtifact[]
  thread: GroupChatThreadView
  chat: GroupChatDetailView
  revealPosition?: number
  onBack: () => void
  onThreadForked: (threadId: string) => void
  onUnavailable: () => void
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts)
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(undefined)
  // The shared session activity, exactly as the group-chat screen reads it
  // for its thread list — one status vocabulary, one source. The header's
  // status line and the list row a reader just came from must never disagree
  // about the same session.
  const status = deriveSessionStatus(thread.sessionKey, useSessionActivity())
  // An agent writes its notes DURING a turn, so the loader's copy is stale the
  // moment one lands. Refetching when a turn finishes is the cheapest signal
  // that something might have changed -- there is no push for artifacts, and
  // polling would cost a request a second to catch a write that happens a few
  // times an hour. The ref guard keeps a refetch that resolves after the
  // reader has moved to another thread from overwriting that thread's strip.
  const threadIdRef = useRef(thread.id)
  threadIdRef.current = thread.id
  const onTurnSettled = useCallback(() => {
    const threadId = thread.id
    listThreadArtifacts({ data: threadId })
      .then((next) => {
        if (threadIdRef.current === threadId) {
          setArtifacts(next)
        }
      })
      .catch((error) => {
        // A failed refresh leaves the last known list on screen, which is
        // better than emptying a strip the reader was using.
        console.error('Failed to refresh thread artifacts', threadId, error)
      })
  }, [thread.id])
  const reader = useSignedInReader()

  return (
    <ScrollPage>
      <GroupChatThreadChat
        thread={thread}
        members={chat.members}
        revealPosition={revealPosition}
        onTurnSettled={onTurnSettled}
        onThreadForked={onThreadForked}
        onUnavailable={onUnavailable}
        reader={reader}
        renderFrame={({ conversation, composer, work, plan }) => (
          <GroupChatThreadFraming
            groupChatName={chat.name}
            threadTitle={thread.title}
            agent={{ name: thread.agent.name, avatarUrl: thread.agent.avatarUrl }}
            status={status}
            work={work}
            plan={plan}
            artifacts={artifacts}
            openArtifactId={openArtifactId}
            onOpenArtifact={setOpenArtifactId}
            onCloseArtifact={() => setOpenArtifactId(undefined)}
            onBack={onBack}
            composer={composer}
          >
            {conversation}
          </GroupChatThreadFraming>
        )}
      />
    </ScrollPage>
  )
}
