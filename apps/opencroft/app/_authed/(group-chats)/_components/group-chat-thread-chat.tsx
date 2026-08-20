'use client'

import { AgentChat } from 'agent-chat/agent-chat'
import { Approvals } from 'agent-chat/approvals'
import { useClearControl } from 'agent-chat/use-clear-control'
import type { CompactStatus } from 'agent-chat/use-compact-control'
import { useCompactControl } from 'agent-chat/use-compact-control'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { CommandBarFrame } from 'ui/agent-chat/command-bar-frame'
import { Flex } from 'ui/layout/flex'
import { StickySection } from 'ui/layouts/sticky-section'
import { ScrollArea } from 'ui/scroll-area'

import { AgentChatStatusIndicators, CHAT_RENDERERS, renderToolCall } from '@/app/_authed/(agent)/_components/agent-chat'
import { AgentCommandBarHost } from '@/app/_authed/(agent)/_components/command-bar-host'
import type { LocalSource, OpenTransport, SendTransport } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { buildBlocks } from '@/app/_authed/(agent)/_lib/build-blocks'
import { wrapUserSelection } from '@/app/_authed/(agent)/_shared/message-envelope'
import { SelectionBadge } from '@/app/_authed/(extension-runtime)/_client/selection-badge'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { threadSendRefusal } from '@/app/_authed/(group-chats)/_lib/send-failure'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  clearGroupChatThread,
  compactGroupChatThread,
  getGroupChatThreadCompactStatus,
  openGroupChatThreadSession,
  sendGroupChatThreadMessage,
  setGroupChatThreadDraft,
} from '@/app/_authed/(group-chats)/_server/actions'

// THE ONE CHAT ASSEMBLY FOR A GROUP-CHAT THREAD. The thread route and the
// extension-embedded chat both render a thread through this component — the
// session wiring (useAcpSession over the membership-checked send), the
// conversation (AgentChat), the approvals, and the composer
// (AgentCommandBarHost) live here exactly once, so a feature added to one
// surface cannot need re-adding on the other. What differs between the two is
// the FRAME around the conversation, and only that: the route wraps it in the
// kit's thread framing (breadcrumbs, artifacts strip) via `renderFrame`, the
// embedded variant takes the default frame below — same scroll and
// sticky-composer arrangement, no group-chat chrome.

/** The two parts a frame arranges. The composer must stay pinned while the
 *  conversation scrolls — see the default frame for the arrangement a frame
 *  is expected to keep. */
export interface ThreadChatParts {
  conversation: ReactNode
  composer: ReactNode
}

interface GroupChatThreadChatProps {
  thread: GroupChatThreadEntry & { draft: string | null }
  /** Extra content at the start of the composer's action row — the embedded
   *  surface puts its agent picker here, mirroring where the start-thread
   *  composer keeps its own. Must be identity-stable when nothing changed. */
  leadingBarContent?: ReactNode
  /** Called each time a turn finishes. The route refreshes the thread's
   *  artifact strip off this — the cheapest signal that an agent may have
   *  written something (there is no push for artifacts). */
  onTurnSettled?: () => void
  /** Arrange the conversation and composer inside host chrome. Omitted, the
   *  default frame renders them as a plain column: conversation scrolling,
   *  composer pinned beneath — the embedded arrangement. */
  renderFrame?: (parts: ThreadChatParts) => ReactNode
}

// Rendered unconditionally in the composer slot: the badge shows nothing
// unless a SelectionProvider with a live selection encloses this component,
// so the plain thread route (no provider) is unchanged by it. Module-level
// for identity stability — it feeds the memoized command bar.
const SELECTION_BADGE = <SelectionBadge />

export function GroupChatThreadChat({
  thread,
  leadingBarContent,
  onTurnSettled,
  renderFrame,
}: GroupChatThreadChatProps) {
  // Memoised on the two values that identify the session, not rebuilt each
  // render: `useAcpSession` keys its effects on this object, so a fresh
  // identity every render would tear the session down and reopen it in a loop.
  const source = useMemo<LocalSource>(
    () => ({ agentNodeId: thread.agent.nodeId, jobNodeId: '', tabKey: thread.sessionKey }),
    [thread.agent.nodeId, thread.sessionKey],
  )

  // The surrounding selection scope, if any (an extension surface mounts one;
  // the thread route does not). Read through a ref inside the transport so the
  // transport's identity — which the session hook keys on — never depends on
  // selection state changing.
  const selectionScope = useOptionalSelection()
  const selectionRef = useRef(selectionScope)
  selectionRef.current = selectionScope

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
  //
  // The scoped selection is attached HERE, at the transport, for the same
  // reason the membership check is: this is the one door a message leaves
  // through, so passing cannot depend on which surface built the composer.
  // The wrapped text is what the agent receives and what the transcript
  // stores; the display side's tag stripper keeps it out of the user bubble.
  //
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
        const scope = selectionRef.current
        const outgoing = scope?.selection && scope.passEnabled ? wrapUserSelection(text, scope.selection.content) : text
        const refusal = threadSendRefusal(
          await sendGroupChatThreadMessage({ data: { threadId: thread.id, text: outgoing, front } }),
        )
        if (refusal) {
          throw refusal
        }
      },
    [thread.id],
  )
  // Opened by THREAD ID, not by the key this screen happens to be holding.
  // `thread.sessionKey` was right when the loader ran, and a rename since then --
  // by anyone, in any tab -- has retired it. Opening by a retired key does not
  // fail: it creates a fresh, empty session under an address nothing else
  // resolves, and the reader sees an empty chat where their conversation was.
  // A thread's id never moves, so the server reads whatever key it has now.
  const openTransport = useCallback<OpenTransport>(() => openGroupChatThreadSession({ data: thread.id }), [thread.id])
  const acp = useAcpSession(source, undefined, thread.agent.name, undefined, sendTransport, openTransport)

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

  // A turn just finished — tell the host, through a ref so an inline callback
  // prop doesn't re-arm the effect every render. The route hangs its artifact
  // refresh off this; a host with nothing to refresh passes nothing.
  const onTurnSettledRef = useRef(onTurnSettled)
  onTurnSettledRef.current = onTurnSettled
  const wasWaiting = useRef(false)
  useEffect(() => {
    const waiting = acp.session.waiting
    const justFinished = wasWaiting.current && !waiting
    wasWaiting.current = waiting
    if (justFinished) {
      onTurnSettledRef.current?.()
    }
  }, [acp.session.waiting])

  // The composer reuses AgentCommandBarHost (the same component the 1:1 chat
  // uses) with `inline` -- it renders the bar here instead of publishing to the
  // dashboard overlay, which neither host surface has a provider for.
  // startIcon is false: a thread is with one fixed agent, so there is no
  // session picker.
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
      leadingBarContent={leadingBarContent}
      configExtraStart={SELECTION_BADGE}
    />
  )

  const conversation = (
    <>
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
    </>
  )

  if (renderFrame) {
    return <>{renderFrame({ conversation, composer })}</>
  }
  // The default (embedded) frame: the same scroll-and-pin arrangement the
  // kit's thread framing keeps, minus its chrome. The scroll-area selector
  // forces Radix's internal viewport wrapper into a filling flex column —
  // without it a short conversation top-anchors and the sticky composer has
  // nothing to pin against; see the kit framing's own note on this exact
  // selector.
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <ScrollArea className='min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:!flex-col [&_[data-radix-scroll-area-viewport]>div]:!min-h-full'>
        <Flex expanded justify='end'>
          {conversation}
        </Flex>
        <StickySection side='bottom' fade>
          <CommandBarFrame>{composer}</CommandBarFrame>
        </StickySection>
      </ScrollArea>
    </div>
  )
}
