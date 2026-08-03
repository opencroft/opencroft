import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'

import { AgentChat } from '@/app/_authed/(agent)/_components/agent-chat'
import type { LocalSource } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { GroupChatErrorState } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { getGroupChatThreadView, getMyGroupChatView } from '@/app/_authed/(group-chats)/_server/actions'

// Reading one thread inside a group chat.
//
// THE CONVERSATION IS NOT REDRAWN HERE. A group-chat thread is an ordinary
// agent session — phase 1 opened it through the same `ensureLocalSessionImpl`
// a 1:1 chat uses, keyed on the thread's `sessionKey` — so this reattaches to
// that session with the same hook and renders it with the same `AgentChat`
// component the 1:1 chat renders. The kit's framing goes around it. Anything
// else would be a fork of the chat surface, which is exactly what the design
// kit being the source of truth is meant to prevent.
//
// Reading only, as phase 2 is scoped: `AgentChat` renders the conversation.
// The composer is a separate component and arrives with phase 3, which is what
// adds conversing.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats_/$groupChatId_/$threadId')({
  loader: async ({ params }) => {
    const thread = await getGroupChatThreadView({ data: params.threadId })
    // The framing shows the topic and who is taking part, which live on the
    // group chat rather than the thread.
    const chat = await getMyGroupChatView({ data: params.groupChatId })
    return { thread, chat }
  },
  component: GroupChatThreadPage,
  errorComponent: GroupChatErrorState,
})

function GroupChatThreadPage() {
  const { thread, chat } = Route.useLoaderData()
  const { groupChatId } = Route.useParams()
  const navigate = useNavigate()

  // Memoised on the two values that identify the session, not rebuilt each
  // render: `useAcpSession` keys its effects on this object, so a fresh
  // identity every render would tear the session down and reopen it in a loop.
  const source = useMemo<LocalSource>(
    () => ({ agentNodeId: thread.agent.nodeId, jobNodeId: '', tabKey: thread.sessionKey }),
    [thread.agent.nodeId, thread.sessionKey],
  )
  const acp = useAcpSession(source, undefined, thread.agent.name)

  return (
    <GroupChatThreadFraming
      groupChatTopic={chat.topic}
      threadTitle={thread.title}
      members={chat.members}
      onBack={() => navigate({ to: '/group-chats/$groupChatId', params: { groupChatId } })}
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
