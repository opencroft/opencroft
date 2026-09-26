import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'
import { ScrollPage } from 'ui/layout/scrollpage'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatThreadChat } from '@/app/_authed/(group-chats)/_components/group-chat-thread-chat'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import type { GroupChatDetailView, GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  getGroupChatThreadView,
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
export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId_/$threadId')({
  // Refusals come back as data rather than as a throw — see
  // _lib/load-or-refusal.ts for the measurement behind that.
  loader: async ({ params }) =>
    loadOrRefusal(async () => {
      const thread = await getGroupChatThreadView({ data: params.threadId })
      // The framing shows the group chat's name as a breadcrumb, which lives
      // on the group chat rather than the thread.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      const artifacts = await listThreadArtifacts({ data: params.threadId })
      return { thread, chat, artifacts }
    }),
  // An untitled thread is named by its chat alone rather than by a
  // placeholder, and a refusal by neither -- pageTitle drops both.
  head: ({ loaderData }) => {
    const loaded = loaderData?.refused === false ? loaderData : undefined
    return { meta: [{ title: pageTitle(loaded?.thread.title, loaded?.chat.name ?? 'Chats') }] }
  },
  component: GroupChatThreadPage,
  errorComponent: GroupChatErrorState,
})

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
    return <GroupChatRefusal code={data.code} />
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
  const { pendingKeys, activeKeys, backgroundKeys, aliveKeys } = useSessionActivityKeys()
  const status = deriveSessionStatus(thread.sessionKey, {
    pending: pendingKeys,
    active: activeKeys,
    background: backgroundKeys,
    alive: aliveKeys,
  })
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
        renderFrame={({ conversation, composer, work }) => (
          <GroupChatThreadFraming
            groupChatName={chat.name}
            threadTitle={thread.title}
            agent={{ name: thread.agent.name, avatarUrl: thread.agent.avatarUrl }}
            status={status}
            work={work}
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
