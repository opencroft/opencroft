import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { AgentCommandBar } from 'ui/agent-chat/agent-command-bar'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'

import { AgentChat } from '@/app/_authed/(agent)/_components/agent-chat'
import type { LocalSource, SendTransport } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import type { GroupChatDetailView, GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  getGroupChatThreadView,
  getMyGroupChatView,
  sendGroupChatThreadMessage,
} from '@/app/_authed/(group-chats)/_server/actions'

// Reading one thread inside a group chat.
//
// THE CONVERSATION IS NOT REDRAWN HERE. A group-chat thread is an ordinary
// agent session — phase 1 opened it through the same `ensureLocalSessionImpl`
// a 1:1 chat uses, keyed on the thread's `sessionKey` — so this reattaches to
// that session with the same hook and renders it with the same `AgentChat`
// component the 1:1 chat renders. The kit's framing goes around it.
//
// Reading only, as phase 2 is scoped: `AgentChat` renders the conversation.
// The composer is a separate component and arrives with phase 3.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId_/$threadId')({
  // Refusals come back as data rather than as a throw — see
  // _lib/load-or-refusal.ts for the measurement behind that.
  loader: async ({ params }) =>
    loadOrRefusal(async () => {
      const thread = await getGroupChatThreadView({ data: params.threadId })
      // The framing shows the topic and who is taking part, which live on the
      // group chat rather than the thread.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      return { thread, chat }
    }),
  component: GroupChatThreadPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatThreadPage() {
  const data = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()

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
      onBack={() => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId } })}
    />
  )
}

function ThreadConversation({
  thread,
  chat,
  onBack,
}: {
  thread: GroupChatThreadEntry & { sessionKey: string }
  chat: GroupChatDetailView
  onBack: () => void
}) {
  // Memoised on the two values that identify the session, not rebuilt each
  // render: `useAcpSession` keys its effects on this object, so a fresh
  // identity every render would tear the session down and reopen it in a loop.
  const source = useMemo<LocalSource>(
    () => ({ agentNodeId: thread.agent.nodeId, jobNodeId: '', tabKey: thread.sessionKey }),
    [thread.agent.nodeId, thread.sessionKey],
  )

  // EVERY SEND GOES THROUGH THE MEMBERSHIP CHECK.
  //
  // The default path a 1:1 chat uses is `promptLocal({ sessionId, ... })`,
  // which is addressed by session id and checks nothing — reusing it here
  // would drop the one server-side rule this feature is built around, for
  // anyone who has a session id. Routing through `sendGroupChatThreadMessage`
  // re-checks membership on the thread before delegating to the same prompt,
  // and going through the hook's transport seam rather than replacing the
  // composer means the send keeps all of its bookkeeping: ordering, the
  // message held while the session is still opening, the waiting state, and
  // `front` for the permission-correction flow.
  const sendTransport = useMemo<SendTransport>(
    () =>
      async ({ text, front }) => {
        await sendGroupChatThreadMessage({ data: { threadId: thread.id, text, front } })
      },
    [thread.id],
  )
  const acp = useAcpSession(source, undefined, thread.agent.name, undefined, sendTransport)
  const [draft, setDraft] = useState('')

  // The composer is the KIT's controlled command bar, not the app's
  // AgentCommandBarHost: that host publishes itself into the dashboard's
  // overlay via useOverlay, which is right where it lives and wrong on a
  // standalone route — the same reason the conversation above uses AgentChat
  // rather than ChatHost.
  //
  // Its send is `acp.session.send`, so it inherits the transport this route
  // passed to useAcpSession: every message goes through
  // sendGroupChatThreadMessage and is membership-checked, while keeping the
  // hook's ordering, held-message and waiting behaviour.
  const composer = (
    <AgentCommandBar
      value={draft}
      onValueChange={setDraft}
      onSend={(text) => {
        acp.session.send(text)
        setDraft('')
      }}
      sending={acp.session.sending}
      busy={acp.session.waiting}
      onStop={acp.session.stop}
      disabled={acp.session.disabled}
      queued={acp.queue}
      onRemoveQueued={acp.removeQueued}
      placeholder={`Message ${thread.agent.name}`}
    />
  )

  return (
    <GroupChatThreadFraming
      groupChatTopic={chat.topic}
      threadTitle={thread.title}
      members={chat.members}
      onBack={onBack}
      composer={composer}
    >
      <AgentChat
        session={acp.session}
        agentAvatar={thread.agent.avatarUrl ?? undefined}
        agentName={thread.agent.name}
        defaultExpanded
      />
    </GroupChatThreadFraming>
  )
}
