import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'
import { ScrollPage } from 'ui/layout/scrollpage'

import { AgentChat } from '@/app/_authed/(agent)/_components/agent-chat'
import { AgentCommandBarHost } from '@/app/_authed/(agent)/_components/command-bar-host'
import type { LocalSource, SendTransport } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { threadSendRefusal } from '@/app/_authed/(group-chats)/_lib/send-failure'
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
  // A refusal here is an answer, not a fault: the agent was removed from the
  // group chat and this thread can be read but not written to. It comes back
  // as data rather than as a throw -- a thrown error reaches the browser as
  // `$TSR/Error` with only its message, so the code identifying WHICH refusal
  // it was does not survive -- and is turned into a SendRefusedError here so
  // the hook shows this copy instead of its generic wording. The hook has no
  // way to know what this endpoint's refusals mean, and should not. A genuine
  // fault still throws out of the call and is reported as a failure.
  const sendTransport = useMemo<SendTransport>(
    () =>
      async ({ text, front }) => {
        const refusal = threadSendRefusal(
          await sendGroupChatThreadMessage({ data: { threadId: thread.id, text, front } }),
        )
        if (refusal) {
          throw refusal
        }
      },
    [thread.id],
  )
  const acp = useAcpSession(source, undefined, thread.agent.name, undefined, sendTransport)

  // The composer reuses AgentCommandBarHost (the same component the 1:1 chat
  // uses) with `inline` -- it renders the bar here instead of publishing to the
  // dashboard overlay, which a standalone route has no provider for. startIcon
  // is false: a thread is with one fixed agent, so there is no session picker.
  //
  // The host sends through `acp.session.send`, which inherits the transport
  // passed to useAcpSession: every message goes through
  // sendGroupChatThreadMessage and is membership-checked, while keeping the
  // hook's ordering, held-message and waiting behaviour.
  // The refusal has to be visible, not just true. Sending into a removed
  // agent's thread is refused server-side, and before this the only trace was a
  // console error: the composer had already cleared itself, so the message
  // simply appeared to vanish. The copy sits directly above the composer, the
  // same place and shape the members dialog reports its own refusals, and the
  // text is back in the composer to be copied or retried.
  const composer = (
    <div className='flex min-w-0 flex-col gap-1'>
      {acp.session.sendError ? (
        <p role='alert' className='px-1 text-sm text-destructive'>
          {acp.session.sendError}
        </p>
      ) : null}
      <AgentCommandBarHost
        inline
        startIcon={false}
        session={acp.session}
        agentNodeId={thread.agent.nodeId}
        queued={acp.queue}
        onRemoveQueued={acp.removeQueued}
        configOptions={acp.configOptions}
        onSetConfigOption={acp.setConfigOption}
        usage={acp.usage}
        placeholder={`Message ${thread.agent.name}`}
      />
    </div>
  )

  return (
    <ScrollPage>
      <GroupChatThreadFraming
        groupChatName={chat.name}
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
    </ScrollPage>
  )
}
