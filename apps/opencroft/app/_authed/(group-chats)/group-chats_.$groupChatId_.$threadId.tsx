import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { Button } from 'ui/button'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'
import { ScrollPage } from 'ui/layout/scrollpage'

import { useSessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import {
  GroupChatRefusal,
  GroupChatThreadGone,
  GroupChatThreadLoadFailed,
} from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatThreadChat } from '@/app/_authed/(group-chats)/_components/group-chat-thread-chat'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import type { GroupChatDetailView, GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
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
// agent session — phase 1 opened it through the same `ensureLocalSessionImpl`
// a 1:1 chat uses, keyed on the thread's `sessionKey` — so this reattaches to
// that session and renders it through GroupChatThreadChat, the one shared
// assembly (session wiring, conversation, approvals, composer) this route now
// has in common with the extension-embedded chat. What is THIS route's own is
// the frame: the kit's thread framing with its breadcrumbs and the artifact
// strip, supplied through the assembly's `renderFrame` slot.
type ThreadPageData =
  | { found: 'gone' }
  | { found: 'refused' }
  | {
      found: 'ok'
      thread: GroupChatThreadEntry & { draft: string | null }
      chat: GroupChatDetailView
      artifacts: ThreadArtifact[]
    }

export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId_/$threadId')({
  // Refusals come back as data rather than as a throw — see
  // _lib/load-or-refusal.ts for the measurement behind that.
  loader: async ({ params }) =>
    loadOrRefusal(async (): Promise<ThreadPageData> => {
      // Looked for inside the chat the URL names, which checks membership
      // first -- so a deleted thread can be told apart from one the reader
      // may not have, and the answer arrives as data rather than a throw.
      const found = await findGroupChatThreadInChat({
        data: { groupChatId: params.groupChatId, threadId: params.threadId },
      })
      if (found.state !== 'ok') {
        return { found: found.state }
      }
      // The framing shows the group chat's name as a breadcrumb, which lives
      // on the group chat rather than the thread.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      const artifacts = await listThreadArtifacts({ data: params.threadId })
      return { found: found.state, thread: found.thread, chat, artifacts }
    }),
  // An untitled thread is named by its chat alone rather than by a
  // placeholder, and a refusal or a deleted thread by neither -- pageTitle
  // drops both.
  head: ({ loaderData }) => {
    const loaded = loaderData?.refused === false && loaderData.found === 'ok' ? loaderData : undefined
    return { meta: [{ title: pageTitle(loaded?.thread.title, loaded?.chat.name ?? 'Chats') }] }
  },
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

// A reader refused this chat would be refused its thread list too, so the way
// out of a refusal is the list of chats they do have.
function BackToChats() {
  return (
    <Button size='sm' variant='outline' nativeButton={false} render={<Link to='/group-chats' />}>
      Back to your chats
    </Button>
  )
}

function GroupChatThreadPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()
  const goToChat = useCallback(
    () => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId } }),
    [navigate, groupChatId],
  )
  const onBack = useSafeBack(goToChat)
  // Where a fork lands: the server creates the destination thread, this opens
  // it — the reader crosses into the new conversation, whose composer already
  // holds the forked message as its draft.
  const onThreadForked = useCallback(
    (threadId: string) => navigate({ to: '/group-chats/$groupChatId/$threadId', params: { groupChatId, threadId } }),
    [navigate, groupChatId],
  )

  if (data.refused) {
    return <GroupChatRefusal code={data.code} action={<BackToChats />} />
  }
  // Not a member: the same collapsed refusal as a chat the reader cannot have.
  if (data.found === 'refused') {
    return <GroupChatRefusal code='not-found' action={<BackToChats />} />
  }
  if (data.found === 'gone') {
    return <GroupChatThreadGone className='py-12' action={<BackToThreadList groupChatId={groupChatId} />} />
  }
  // The session lives in its own component so its hooks are never behind the
  // refusal branch above — a hook after an early return is a different hook
  // order between renders, which React does not allow.
  return (
    <ThreadConversation
      thread={data.thread}
      chat={data.chat}
      artifacts={data.artifacts}
      onBack={onBack}
      onThreadForked={onThreadForked}
    />
  )
}

function ThreadConversation({
  thread,
  chat,
  artifacts: initialArtifacts,
  onBack,
  onThreadForked,
}: {
  artifacts: ThreadArtifact[]
  thread: GroupChatThreadEntry & { draft: string | null }
  chat: GroupChatDetailView
  onBack: () => void
  onThreadForked: (threadId: string) => void
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

  return (
    <ScrollPage>
      <GroupChatThreadChat
        thread={thread}
        onTurnSettled={onTurnSettled}
        onThreadForked={onThreadForked}
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
