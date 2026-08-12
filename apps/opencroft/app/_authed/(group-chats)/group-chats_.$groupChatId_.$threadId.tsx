import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AgentChat } from 'agent-chat/agent-chat'
import { Approvals } from 'agent-chat/approvals'
import { useClearControl } from 'agent-chat/use-clear-control'
import type { CompactStatus } from 'agent-chat/use-compact-control'
import { useCompactControl } from 'agent-chat/use-compact-control'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GroupChatThreadFraming } from 'ui/group-chat/group-chat-thread-framing'
import { ScrollPage } from 'ui/layout/scrollpage'

import { AgentChatStatusIndicators, CHAT_RENDERERS, renderToolCall } from '@/app/_authed/(agent)/_components/agent-chat'
import { AgentCommandBarHost } from '@/app/_authed/(agent)/_components/command-bar-host'
import type { LocalSource, SendTransport } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { buildBlocks } from '@/app/_authed/(agent)/_lib/build-blocks'
import { GroupChatErrorState, GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { threadSendRefusal } from '@/app/_authed/(group-chats)/_lib/send-failure'
import { useSafeBack } from '@/app/_authed/(group-chats)/_lib/use-safe-back'
import type { GroupChatDetailView, GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  clearGroupChatThread,
  compactGroupChatThread,
  getGroupChatThreadCompactStatus,
  getGroupChatThreadView,
  getMyGroupChatView,
  listThreadArtifacts,
  sendGroupChatThreadMessage,
  setGroupChatThreadDraft,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { ThreadArtifact } from '@/app/_authed/(group-chats)/_server/artifacts'

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
      // The framing shows the group chat's name as a breadcrumb, which lives
      // on the group chat rather than the thread.
      const chat = await getMyGroupChatView({ data: params.groupChatId })
      const artifacts = await listThreadArtifacts({ data: params.threadId })
      return { thread, chat, artifacts }
    }),
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

  if (data.refused) {
    return <GroupChatRefusal code={data.code} />
  }
  // The session lives in its own component so its hooks are never behind the
  // refusal branch above — a hook after an early return is a different hook
  // order between renders, which React does not allow.
  return <ThreadConversation thread={data.thread} chat={data.chat} artifacts={data.artifacts} onBack={onBack} />
}

function ThreadConversation({
  thread,
  chat,
  artifacts: initialArtifacts,
  onBack,
}: {
  artifacts: ThreadArtifact[]
  thread: GroupChatThreadEntry & { draft: string | null }
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

  // Computed over the FULL message list, not the visible window: turn indices
  // (for edit/fork) must stay correct regardless of how much is rendered, and
  // folding/building is cheap next to the cost of actually rendering blocks.
  const blocks = useMemo(
    () => buildBlocks(acp.session.messages, acp.session.historyHeader?.index),
    [acp.session.messages, acp.session.historyHeader?.index],
  )

  // Compacts and clears THIS thread, membership-checked (see clearThread's
  // own comment in model.ts for why clearSession -- generic across both
  // surfaces, no check of any kind -- isn't used here directly). Keyed on
  // thread.id, not the session key: that's what the underlying server calls
  // actually key on, and useCompactControl/useClearControl's key parameter
  // is opaque (see their own comments) -- it only has to match what the
  // callbacks below expect.
  const fetchCompactStatus = useCallback(
    (threadId: string): Promise<CompactStatus> => getGroupChatThreadCompactStatus({ data: threadId }),
    [],
  )
  // Mirrors the 1:1 chat's own requestCompact (chat-hosts.tsx): a genuine,
  // non-access failure -- compactGroupChatThread only catches
  // GroupChatAccessError itself, so requestCompactOnGraph's own throws (no
  // live process for this session, or no standing-context resolver claimed
  // it) come through as an ordinary thrown error, not a `{ok:false, code}`
  // result. Without this try/catch that rejection fell through uncaught to
  // useAsyncActionStatus's generic `.catch(() => setRefusal('That could not
  // be completed.'))` -- indistinguishable on screen from a membership
  // refusal, and not even the same copy as one. Catching it here and giving
  // it its OWN message (not routed through groupChatAccessMessageForCode,
  // which is for access refusals only) is "surfacing as itself".
  const requestCompact = useCallback(
    async (threadId: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      try {
        const result = await compactGroupChatThread({ data: threadId })
        if (result.ok) {
          return { ok: true }
        }
        return { ok: false, message: groupChatAccessMessageForCode(result.code) }
      } catch {
        return { ok: false, message: 'This session could not be compacted.' }
      }
    },
    [],
  )
  const compact = useCompactControl(thread.id, fetchCompactStatus, requestCompact)
  // The membership-checked server call above tears the session down, but
  // useAcpSession -- still holding the old sessionId, EventSource and
  // rendered messages -- is never told: without the second step below, the
  // transcript only reflects the clear after the tab is torn down and
  // rebuilt some other way (leaving the thread and reopening it). Driving
  // acp.session.clearSession() is the SAME reset the 1:1 surface gets from
  // its own Clear button -- its own forgetLocalSession call lands on an
  // already-gone tabKey and is a no-op (see forgetLocalSessionImpl), so what
  // it actually contributes here is the generation bump that makes
  // useAcpSession's resolve-session effect re-run and reattach to a fresh
  // session in place, rather than a second, competing teardown path.
  const clearSession = useCallback(async () => {
    try {
      await clearGroupChatThread({ data: thread.id })
    } catch (err) {
      console.error('Failed to clear thread', thread.id, err)
      return
    }
    await acp.session.clearSession?.()
  }, [thread.id, acp.session.clearSession])
  const clear = useClearControl(clearSession)

  // AgentCommandBarHost hands back the sessionKey it was given as `key` (it
  // is `thread.sessionKey`, the same value passed as `source.tabKey` above),
  // but the draft belongs to the thread ROW, not a settings-list entry keyed
  // by that string -- unlike the 1:1 chat's SessionEntry.draft, so this closes
  // over thread.id instead of using the callback's own key argument.
  const onDraftChange = useCallback(
    (_key: string, draft: string) => {
      setGroupChatThreadDraft({ data: { threadId: thread.id, draft } }).catch((err) => {
        console.error('Failed to save thread draft', thread.id, err)
      })
    },
    [thread.id],
  )

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
  // simply appeared to vanish. The kit's error slot renders it directly above
  // the composer, the same place and shape the members dialog reports its own
  // refusals, and the text is back in the composer to be copied or retried.
  const composer = (
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
      compact={compact}
      onClear={clear.onClear}
      placeholder={`Message ${thread.agent.name}`}
      sendError={acp.session.sendError}
      onDismissSendError={acp.session.dismissSendError}
      savedDraft={thread.draft ?? undefined}
      onDraftChange={onDraftChange}
    />
  )

  const [artifacts, setArtifacts] = useState(initialArtifacts)
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(undefined)
  // An agent writes its notes DURING a turn, so the loader's copy is stale the
  // moment one lands. Refetching when a turn finishes is the cheapest signal
  // that something might have changed -- there is no push for artifacts, and
  // polling would cost a request a second to catch a write that happens a few
  // times an hour.
  const wasWaiting = useRef(false)
  useEffect(() => {
    const waiting = acp.session.waiting
    const justFinished = wasWaiting.current && !waiting
    wasWaiting.current = waiting
    if (!justFinished) {
      return
    }
    let cancelled = false
    listThreadArtifacts({ data: thread.id })
      .then((next) => {
        if (!cancelled) {
          setArtifacts(next)
        }
      })
      .catch((error) => {
        // A failed refresh leaves the last known list on screen, which is
        // better than emptying a strip the reader was using.
        console.error('Failed to refresh thread artifacts', thread.id, error)
      })
    return () => {
      cancelled = true
    }
  }, [acp.session.waiting, thread.id])

  return (
    <ScrollPage>
      <GroupChatThreadFraming
        groupChatName={chat.name}
        threadTitle={thread.title}
        agent={{ name: thread.agent.name, avatarUrl: thread.agent.avatarUrl }}
        artifacts={artifacts}
        openArtifactId={openArtifactId}
        onOpenArtifact={setOpenArtifactId}
        onCloseArtifact={() => setOpenArtifactId(undefined)}
        onBack={onBack}
        composer={composer}
      >
        <AgentChat
          session={acp.session}
          blocks={blocks}
          hasMessages={acp.session.messages.length > 0}
          historyHeaderText={acp.session.historyHeader?.text}
          agentAvatar={thread.agent.avatarUrl ?? undefined}
          agentName={thread.agent.name}
          defaultExpanded
          renderTool={renderToolCall}
          renderers={CHAT_RENDERERS}
          footerExtra={<AgentChatStatusIndicators />}
        />
        {/* A thread's agent asks for approval exactly as a 1:1 chat's does, and
            without this there is nowhere to answer: the request renders in the
            transcript with no controls, and the turn's only exit is being
            killed — which reaches the agent as a refusal nobody meant. Same
            component and the same position relative to the conversation the
            1:1 host uses, so the two surfaces cannot drift. */}
        <Approvals session={acp} />
      </GroupChatThreadFraming>
    </ScrollPage>
  )
}
