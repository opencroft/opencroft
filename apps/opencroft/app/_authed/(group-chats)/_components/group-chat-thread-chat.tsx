'use client'

import { AgentChat, type AgentChatReveal } from 'agent-chat/agent-chat'
import type { AgentComposerHandle } from 'agent-chat/agent-command-bar'
import { Approvals } from 'agent-chat/approvals'
import type { PlanEntry } from 'agent-chat/components/agent-plan-control'
import { WORK_ID_ATTR } from 'agent-chat/components/chat-turn'
import { useClearControl } from 'agent-chat/use-clear-control'
import type { CompactStatus } from 'agent-chat/use-compact-control'
import { useCompactControl } from 'agent-chat/use-compact-control'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CommandBarFrame } from 'ui/agent-chat/command-bar-frame'
import { ArchivedThreadNotice } from 'ui/group-chat/archived-thread-notice'
import type { ThreadWork, ThreadWorkItem } from 'ui/group-chat/thread-work-control'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { StickySection } from 'ui/layouts/sticky-section'

import { AgentChatStatusIndicators, CHAT_RENDERERS, renderToolCall } from '@/app/_authed/(agent)/_components/agent-chat'
import { AgentCommandBarHost } from '@/app/_authed/(agent)/_components/command-bar-host'
import { SessionOpenNotice } from '@/app/_authed/(agent)/_components/session-open-notice'
import type {
  ForkTransport,
  LocalSource,
  OpenTransport,
  SendTransport,
} from '@/app/_authed/(agent)/_components/use-acp-session'
import { useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { buildBlocks, buildUnread } from '@/app/_authed/(agent)/_lib/build-blocks'
import { useSessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { locateRecordedTurnLocal } from '@/app/_authed/(agent)/_server/acp'
import { wrapUserSelection } from '@/app/_authed/(agent)/_shared/message-envelope'
import { openedOrThrow } from '@/app/_authed/(agent)/_shared/session-open-refusal'
import { SelectionBadge } from '@/app/_authed/(extension-runtime)/_client/selection-badge'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { SelectionToggle } from '@/app/_authed/(extension-runtime)/_client/selection-toggle'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { threadSendRefusal } from '@/app/_authed/(group-chats)/_lib/send-failure'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  attachGroupChatThreadSession,
  clearGroupChatThread,
  compactGroupChatThread,
  forkGroupChatThreadAt,
  getGroupChatThreadCompactStatus,
  openGroupChatThreadSession,
  sendGroupChatThreadMessage,
  setGroupChatThreadArchived,
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

/** The session's header controls, for a frame or host with a header to put
 *  them in: `work` is the delegated-work summary (subagents and background
 *  tasks, with a jump to each one's block), `plan` the agent's current plan
 *  (empty while it has none). */
export interface ThreadHeaderControls {
  work: ThreadWork
  plan: PlanEntry[]
}

/** The parts a frame arranges. The composer must stay pinned while the
 *  conversation scrolls — see the default frame for the arrangement a frame
 *  is expected to keep. The default frame has no header and simply doesn't
 *  read the header controls. */
export interface ThreadChatParts extends ThreadHeaderControls {
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
  /** Opens the thread a FORK created, once the server has made it. Omitted,
   *  the fork action is not offered in this surface — the menu simply has no
   *  Fork item, the same degradation a missing handler gives Edit. */
  onThreadForked?: (threadId: string) => void
  /** Arrange the conversation and composer inside host chrome. Omitted, the
   *  default frame renders them as a plain column: conversation scrolling,
   *  composer pinned beneath — the embedded arrangement. */
  renderFrame?: (parts: ThreadChatParts) => ReactNode
  /** Reports the session's header controls — the same `work` and `plan` the
   *  frame contract carries — whenever they change, for a host whose header
   *  lives OUTSIDE this component: the dock window already has one per
   *  arrangement, and a second one inside the surface read as two. Read
   *  through a ref, so an inline callback never re-arms the effect. */
  onHeaderChange?: (controls: ThreadHeaderControls) => void
  /** Open the conversation at the turn in this position (what a message
   *  search hit names) instead of at its end. Once per thread and position:
   *  the same value arriving again does not scroll the reader back. */
  revealPosition?: number
}

const TURN_GONE_MESSAGE = 'That message is no longer in this conversation.'
// Search keeps a thread's whole history; the conversation keeps a bounded
// tail of it, so a hit can name a message the thread can no longer show.
const TURN_OLDER_MESSAGE = 'That message is older than the history kept for this conversation.'

// The two halves of the selection in the composer: the quotation that rides in
// the attachments row above the input, and the toggle that stands beside the
// context ring below it. Neither renders anything unless a SelectionProvider
// with a live selection encloses this component, so the plain thread route (no
// provider) is unchanged by both. Module-level for identity stability — they
// feed the memoized command bar.
//
// Each is handed to its slot on the same condition its own component draws on,
// which is a second test of that condition and has to be. A slot draws around
// whatever it is given, and an element that renders null is still an element —
// so passing either unconditionally would put a strip of empty row under the
// composer at all times, which is exactly what those slots are built not to do.
// The two tests are asking different questions: this one whether the slot
// exists, the component's own whether there is anything to draw in it.
//
// AND THE TWO CONDITIONS ARE NOT THE SAME ONE. The quotation needs something to
// quote. The toggle needs somewhere to keep the answer it sets, which is any
// mounted scope — so it stands with nothing selected, and the reader can settle
// it before selecting anything. The plain thread route has no provider and gets
// neither.
const SELECTION_BADGE = <SelectionBadge />
const SELECTION_TOGGLE = <SelectionToggle />

export function GroupChatThreadChat({
  thread,
  leadingBarContent,
  onTurnSettled,
  onThreadForked,
  renderFrame,
  onHeaderChange,
  revealPosition,
}: GroupChatThreadChatProps) {
  // Memoised on the two values that identify the session, not rebuilt each
  // render: `useAcpSession` keys its effects on this object, so a fresh
  // identity every render would tear the session down and reopen it in a loop.
  const source = useMemo<LocalSource>(
    () => ({ agentNodeId: thread.agent.nodeId, tabKey: thread.sessionKey }),
    [thread.agent.nodeId, thread.sessionKey],
  )

  // Archived state, confirmed locally the moment Unarchive succeeds rather
  // than waited out through a reload: this component has no host-owned
  // refresh to lean on (the embedded surface's home screen and the route's
  // loader both sit outside it), and the thread itself needs nothing else to
  // change once writing is allowed again. Reset whenever the thread identity
  // changes, so a stale override from a previous thread can never survive a
  // switch between two open at once.
  const refresh = useGroupChatRefresh()
  const [archivedOverride, setArchivedOverride] = useState<boolean | null>(null)
  const [unarchiving, setUnarchiving] = useState(false)
  const [unarchiveError, setUnarchiveError] = useState<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies(thread.id): not read in the body — it exists to reset this state when the thread identity changes, not because either setter reads it
  useEffect(() => {
    setArchivedOverride(null)
    setUnarchiveError(undefined)
  }, [thread.id])
  const archived = archivedOverride ?? thread.archived
  const unarchive = useCallback(async () => {
    setUnarchiveError(undefined)
    setUnarchiving(true)
    try {
      const result = await setGroupChatThreadArchived({ data: { threadId: thread.id, archived: false } })
      if (!result.ok) {
        setUnarchiveError(groupChatAccessMessageForCode(result.code))
        return
      }
      setArchivedOverride(false)
      // The thread is back in the chat's list; the lists around it reload.
      await refresh()
    } catch (err) {
      console.error('Failed to unarchive thread', thread.id, err)
      setUnarchiveError('This thread could not be unarchived.')
    } finally {
      setUnarchiving(false)
    }
  }, [thread.id, refresh])

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
      async ({ text, front, attachments }) => {
        const scope = selectionRef.current
        const outgoing = scope?.selection && scope.passEnabled ? wrapUserSelection(text, scope.selection.content) : text
        const refusal = threadSendRefusal(
          await sendGroupChatThreadMessage({
            data: {
              threadId: thread.id,
              text: outgoing,
              front,
              queue: 'wait',
              ...(attachments?.length ? { attachments: [...attachments] } : {}),
            },
          }),
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
  //
  // The session id it answers with is kept for the reveal below: the hook does
  // not hand its id out, and locating a turn is addressed by session id. Tagged
  // with the thread so an id from the thread just left is never used.
  const [openedSession, setOpenedSession] = useState<{ threadId: string; sessionId: string } | null>(null)
  const openTransport = useCallback<OpenTransport>(
    async (_source, { wake }) => {
      const opened = wake
        ? openedOrThrow(await openGroupChatThreadSession({ data: thread.id }))
        : await attachGroupChatThreadSession({ data: thread.id })
      if (opened) {
        setOpenedSession({ threadId: thread.id, sessionId: opened.sessionId })
      }
      return opened
    },
    [thread.id],
  )

  // Opening at a turn: asked once the session is open, because the turn is
  // looked up in the session's recorded log. The answer is a log index, which
  // is what the blocks' ids are made of (see build-blocks), so it becomes the
  // two ids that turn can render as. `reveal` is state so AgentChat sees one
  // request object, not a new one per render. A turn the log no longer holds
  // -- the thread was cleared or rewritten since the search -- is told to the
  // reader rather than left as a thread that silently opened at the end.
  const [reveal, setReveal] = useState<AgentChatReveal | null>(null)
  const revealAskedRef = useRef<string | null>(null)
  const openedSessionId = openedSession?.threadId === thread.id ? openedSession.sessionId : null
  useEffect(() => {
    if (revealPosition === undefined) {
      revealAskedRef.current = null
      setReveal(null)
      return
    }
    if (!openedSessionId) {
      return
    }
    const asked = `${thread.id}\n${revealPosition}`
    if (revealAskedRef.current === asked) {
      return
    }
    revealAskedRef.current = asked
    setReveal(null)
    locateRecordedTurnLocal({ data: { sessionId: openedSessionId, position: revealPosition } })
      .then((location) => {
        if (revealAskedRef.current !== asked) {
          return
        }
        if (location.kind !== 'found') {
          toast(location.kind === 'older' ? TURN_OLDER_MESSAGE : TURN_GONE_MESSAGE)
          return
        }
        const { index } = location
        setReveal({
          blockIds: [`u:${index}`, `t:${index}`],
          onSettled: (found) => {
            if (!found) {
              toast(TURN_GONE_MESSAGE)
            }
          },
        })
      })
      .catch((err) => {
        console.error('Failed to locate the message in the thread', thread.id, err)
        if (revealAskedRef.current === asked) {
          toast('That message could not be located.')
        }
      })
  }, [thread.id, revealPosition, openedSessionId])

  // Fork into a NEW thread: the server branches this thread's session before
  // the chosen turn, creates the destination thread and stages the forked
  // message as its draft; the host opens it. The outcome comes back as data —
  // a refusal ('not-found' covers both a thread the caller cannot have and a
  // message that is no longer there) is shown, not thrown, so a stale screen
  // reports instead of breaking.
  const onThreadForkedRef = useRef(onThreadForked)
  onThreadForkedRef.current = onThreadForked
  const forkTransport = useMemo<ForkTransport | undefined>(
    () =>
      onThreadForked
        ? async ({ eventIndex, draft }) => {
            const outcome = await forkGroupChatThreadAt({ data: { threadId: thread.id, eventIndex, draft } })
            if (outcome.ok) {
              onThreadForkedRef.current?.(outcome.thread.id)
            } else {
              toast.error(groupChatAccessMessageForCode(outcome.code))
            }
          }
        : undefined,
    [thread.id, onThreadForked],
  )
  const acp = useAcpSession(source, thread.agent.name, sendTransport, openTransport, forkTransport)

  // Computed over the FULL message list, not the visible window: turn indices
  // (for edit/fork) must stay correct regardless of how much is rendered, and
  // folding/building is cheap next to the cost of actually rendering blocks.
  const blocks = useMemo(
    () =>
      buildBlocks(acp.session.messages, acp.session.historyHeader?.index, acp.stopBackgroundTask, thread.sessionKey),
    [acp.session.messages, acp.session.historyHeader?.index, acp.stopBackgroundTask, thread.sessionKey],
  )

  const unread = useMemo(
    () => buildUnread(acp.queue, acp.queueAuthors, thread.sessionKey),
    [acp.queue, acp.queueAuthors, thread.sessionKey],
  )
  // Memoized for the same reason as `unread`: it feeds the memoized command
  // bar, and a fresh object every render would rebuild it every render.
  const presence = useMemo(
    () => ({ value: acp.presence, onSelect: acp.setPresence, steering: acp.canSteer }),
    [acp.presence, acp.setPresence, acp.canSteer],
  )

  // The header's delegated-work panel, derived from the FOLDED parts rather
  // than the out-of-band task list: every entry here names a block the jump
  // below can land on, which a task the harness kept out of the transcript
  // (showInTranscript false) deliberately is not.
  const workItems = useMemo(() => {
    const items: ThreadWorkItem[] = []
    for (const message of acp.session.messages) {
      for (const part of message.parts) {
        if (part.type === 'subagent') {
          items.push({
            id: part.subagentSessionId,
            kind: 'subagent',
            name: part.name || 'Subagent',
            // The same reading the block gives it: no state yet IS running.
            state: part.state ?? 'running',
            live: part.state === undefined,
          })
        } else if (part.type === 'async-task') {
          items.push({
            id: part.asyncTaskId,
            kind: 'task',
            name: part.name || part.taskType || 'Task',
            state: part.state,
            live: part.state === 'running' || part.state === 'paused',
          })
        }
      }
    }
    return items
  }, [acp.session.messages])

  // The session read through a ref so `jumpToWork` keeps ONE identity for the
  // life of the component — it feeds the memoized `work` object below, and a
  // dependency on the session would rebuild both on every folded event.
  const acpSessionRef = useRef(acp.session)
  acpSessionRef.current = acp.session

  // Scroll to a subagent's or task's block, paging older history in until it
  // is in the DOM. Bounded twice: by the history cursor itself (hasMoreHistory
  // goes false at the true start) and by a hard page cap, so a cursor that
  // never settles cannot spin this forever.
  const jumpToWork = useCallback(async (id: string) => {
    const find = () => document.querySelector<HTMLElement>(`[${WORK_ID_ATTR}="${CSS.escape(id)}"]`)
    // loadMoreHistory resolves when the page's events are handed to React,
    // not when the DOM shows them — wait out a paint before asking the DOM.
    const afterPaint = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const MAX_PAGES = 40
    let target = find()
    for (let page = 0; !target && acpSessionRef.current.hasMoreHistory && page < MAX_PAGES; page++) {
      // Optional on the session contract; a session with more history but no
      // way to load it has nothing else this loop could do, so stop.
      if (!acpSessionRef.current.loadMoreHistory) {
        break
      }
      await acpSessionRef.current.loadMoreHistory()
      await afterPaint()
      target = find()
    }
    if (!target) {
      return
    }
    target.scrollIntoView({ block: 'center' })
    // A brief ring so the eye lands on the right block after the jump. The
    // classes are removed rather than toggled by state: the flash is not a
    // fact about the block, just the landing light.
    const el = target
    el.classList.add('ring-2', 'ring-primary')
    window.setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1500)
  }, [])

  // The badge counts everything live in the panel — running subagents and
  // running/paused tasks alike — so it reads as "how many things are going".
  const work = useMemo<ThreadWork>(
    () => ({
      items: workItems,
      liveCount: workItems.filter((item) => item.live).length,
      onJump: jumpToWork,
    }),
    [workItems, jumpToWork],
  )

  const headerControls = useMemo<ThreadHeaderControls>(() => ({ work, plan: acp.plan }), [work, acp.plan])

  // Hand the controls out as they change. They are memoized above, so this
  // fires once per real change and a host may hold what it gets in state.
  const onHeaderChangeRef = useRef(onHeaderChange)
  onHeaderChangeRef.current = onHeaderChange
  useEffect(() => {
    onHeaderChangeRef.current?.(headerControls)
  }, [headerControls])

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
  // A genuine, non-access failure -- compactGroupChatThread only catches
  // GroupChatAccessError itself, so requestCompact's own throws (no
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
  const compactJob = useCompactControl(thread.id, fetchCompactStatus, requestCompact)
  // The job knows only the compactions this surface asked for. The engine
  // reports every one in progress, the harness's automatic ones and a typed
  // `/compact` included, and the ring shows those as compacting too.
  const harnessCompacting = useSessionActivity().compacting.has(thread.sessionKey)
  const compact = useMemo(
    () => (harnessCompacting && !compactJob.compacting ? { ...compactJob, compacting: true } : compactJob),
    [compactJob, harnessCompacting],
  )
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
  const composerRef = useRef<AgentComposerHandle>(null)

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

  // The composer is AgentCommandBarHost, which returns the bar for this
  // component to place. startIcon is false: a thread is with one fixed agent,
  // so there is no session picker.
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
  //
  // `composerRef` is the one link from the transcript to the composer: a
  // message's Reply writes into the composer through it.
  // An archived thread trades its composer for the notice: sending into it is
  // refused server-side regardless, but leaving the composer up would invite
  // a person to type into a box that can never deliver, and clear only after
  // the refusal comes back.
  const composer = archived ? (
    <ArchivedThreadNotice onUnarchive={() => void unarchive()} pending={unarchiving} error={unarchiveError} />
  ) : (
    <AgentCommandBarHost
      startIcon={false}
      session={acp.session}
      agentNodeId={thread.agent.nodeId}
      configOptions={acp.configOptions}
      onSetConfigOption={acp.setConfigOption}
      presence={presence}
      usage={acp.usage}
      compact={compact}
      onClear={clear.onClear}
      placeholder={`Message ${thread.agent.name}`}
      sendError={acp.session.sendError}
      onDismissSendError={acp.session.dismissSendError}
      savedDraft={thread.draft ?? undefined}
      onDraftChange={onDraftChange}
      leadingBarContent={leadingBarContent}
      attachments={selectionScope?.selection && selectionScope.passEnabled ? SELECTION_BADGE : undefined}
      attachmentControls={selectionScope ? SELECTION_TOGGLE : undefined}
      canAttachImages={acp.canAttachImages}
      composerRef={composerRef}
    />
  )

  const conversation = (
    <>
      <AgentChat
        session={acp.session}
        blocks={blocks}
        hasMessages={acp.session.messages.length > 0}
        historyHeaderParts={acp.session.historyHeader?.parts}
        agentAvatar={thread.agent.avatarUrl ?? undefined}
        agentName={thread.agent.name}
        defaultExpanded
        renderTool={renderToolCall}
        renderers={CHAT_RENDERERS}
        unread={unread}
        onRemoveUnread={acp.removeQueued}
        onDeliverUnread={acp.deliverQueue}
        composerRef={composerRef}
        reveal={reveal}
        footerExtra={
          <>
            {/* In the footer so it stands under an empty chat and under a
                transcript that lost its connection alike. */}
            <SessionOpenNotice message={acp.openError} onRetry={acp.retryOpen} />
            <AgentChatStatusIndicators />
          </>
        }
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
    return <>{renderFrame({ conversation, composer, ...headerControls })}</>
  }
  // The default (embedded) frame: the same scroll-and-pin arrangement the
  // kit's thread framing keeps, minus its chrome. `min-h-full` makes the scroll
  // area's content column fill the viewport — without it a short conversation
  // top-anchors and the sticky composer has nothing to pin against; see the kit
  // framing's own note on this arrangement.
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <ScrollArea className='min-h-0 flex-1' innerClassName='min-h-full'>
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
