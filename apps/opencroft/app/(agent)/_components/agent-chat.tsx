'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ChainDot, type ChainDotVariant, Chained } from 'agent-chat/chain'
import { ConfigOptionsBar } from 'agent-chat/config-options-bar'
import { ThinkingBlock } from 'agent-chat/thinking-block'
import { groupIntoTurnSections } from 'agent-chat/turn-sections'
import type { QueuedPrompt } from 'agent-client/types'
import {
  Maximize2,
  Minimize2,
  Pencil,
  SendIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldCog,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import {
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from 'ui/button'
import { TypingDots } from 'ui/chat/typing-dots'
import { Flex } from 'ui/layout/flex'
import { AgentAvatar } from 'ui/media/agent-avatar'
import { Textarea } from 'ui/textarea'

import { type Block, buildBlocks, type DetailItem, stripOpencroftTags } from '@/app/(agent)/_lib/build-blocks'
import { shouldFill } from '@/app/(agent)/_lib/history-fill'
import type { ChatMessage } from '@/app/(agent)/_lib/messages'
import { decideScrollAction, isAtBottom, type ScrollCause } from '@/app/(agent)/_lib/scroll-intent'
import { contentTop, HOLD_DEADLINE_MS, type HoldState, holdExpired, holdStep } from '@/app/(agent)/_lib/scroll-restore'
import { getAutoApprove, setAutoApprove } from '@/app/(approvals)/_server/actions'
import { useOverlay } from '@/app/(dashboard)/_canvas/overlay-context'
import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/(extension-runtime)/_client/provides'
import { GenericToolView } from '@/components/tool-views/builtin-views'
import { lookupToolView } from '@/components/tool-views/registry'
import { cn } from '@/lib/utils'

export interface AgentSession {
  sessionKey: string
  messages: ChatMessage[]
  loading: boolean
  sending: boolean
  waiting: boolean
  botName: string
  send: (text: string) => void
  // Turn control and message editing, provided by the ACP (local) backend; the
  // dashboard placeholder session leaves these unset.
  stop?: () => void
  canFork?: boolean
  // Rewind history to a user turn (0-based) and prefill its text for re-sending.
  editMessage?: (turnIndex: number, text: string) => void
  // Composer draft staged by editMessage; the input syncs to it when it changes.
  draft?: { text: string; key: number }
  // When set, the composer's send is disabled (e.g. no agent selected yet).
  disabled?: boolean
  // Whether the server has earlier history than what's currently in `messages`
  // — a cold-opened chat starts from a bounded tail window, not the full
  // transcript, so a long conversation needs
  // "load older" to see anything further back.
  hasMoreHistory?: boolean
  loadingMoreHistory?: boolean
  // Fetches and prepends the next page of older history, resolving once
  // `messages` reflects it (or immediately, as a no-op, while a fetch is
  // already in flight or once hasMoreHistory is false) — callers await it to
  // sequence a DOM-window/scroll-position change with the data actually
  // landing, instead of the two racing.
  loadMoreHistory?: () => Promise<void>
  // The turn the loaded history starts inside, when only part of that turn is
  // loaded — its own `user` event sits above the window. Supplies the leading
  // section's sticky header text, and its `index` names the leading details
  // block so a mid-turn page merging into that block doesn't rename it.
  historyHeader?: { index: number; text: string } | null
}

interface AgentChatProps {
  session: AgentSession
  emptyText?: string
  agentAvatar?: string
  agentName?: string
  // When true, chains render expanded (full detail) by default instead of the
  // collapsed last-message-only view.
  defaultExpanded?: boolean
}

// Input that means the reader is moving the view themselves. A hold is
// cancelled from these rather than from `scroll`, because our own corrections
// raise `scroll` — and so does the browser's scroll anchoring where it still
// applies — so a hold cancelled by `scroll` would cancel itself on the first
// correction it made. No gesture accompanies either of those.
const USER_SCROLL_GESTURES = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

// A position being held across a prepend while the content above settles.
interface ActiveHold {
  state: HoldState
  // When corrections started, or null while the fetched page has yet to land.
  // The deadline and the quiescence check both run from this rather than from
  // the capture, so a slow request doesn't spend the budget that exists to
  // bound how long the content takes to settle.
  settlingSince: number | null
  // TEMPORARY: the anchor's position on SCREEN at
  // capture, for the double-correction probe below.
  viewportTop: number | null
}

// A hold that ends on its deadline rather than on the content settling means
// something above the reader never stopped resizing. Said out loud rather than
// absorbed: silently giving up is how this class of bug stayed invisible for
// three rebuilds.
let holdDeadlineReportsLeft = 3
function reportHoldDeadline(): void {
  if (holdDeadlineReportsLeft <= 0) {
    return
  }
  holdDeadlineReportsLeft -= 1
  console.warn(
    `[chat-scroll] gave up holding the reader's position after ${HOLD_DEADLINE_MS}ms —` +
      ' content above the reader never stopped changing size',
  )
}

// Everything that can move the chat's scroll position, in one place.
//
// It used to be five: this hook's pinned state, its ResizeObserver, its
// content-key effect, the session-reset effect, and a separate restore effect
// in AgentChat — each measuring the DOM and each writing scrollTop, held apart
// by a `holdPosition()` gate that every new path had to remember to consult.
// Every failure it had was two of them acting on one commit and disagreeing.
//
// Now there is one decision (scroll-intent.ts), taken from the reason the
// update happened, and one place that writes the position.
interface ChatScrollParams {
  // Identity of the conversation. A change means "land at the end".
  sessionKey: string
  // The rendered content; only its identity is used, to re-ask on the commit
  // that changed it.
  blocks: readonly Block[]
  // Topmost rendered block — the anchor a prepend is measured against.
  topBlockId: string | null
  // Read fresh on every check rather than closed over, so a fetch flipping the
  // loading flag doesn't change the identity of these callbacks and tear down
  // the listeners that call them.
  session: AgentSession
}

function useChatScroll({ sessionKey, blocks, topBlockId, session }: ChatScrollParams) {
  const rootRef = useRef<HTMLDivElement>(null)
  // The first REAL block, so the fill check measures from content rather than
  // from the loading indicator rendered above it.
  const firstBlockRef = useRef<HTMLDivElement>(null)

  const viewport = useCallback(
    () => rootRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null,
    [],
  )

  // Where the reader was BEFORE the commit being decided. Maintained by the
  // scroll listener, never measured after new content has landed — by then the
  // content itself has changed the answer.
  const atBottomRef = useRef(true)
  // Why the next commit is happening, set by whatever causes it.
  const causeRef = useRef<ScrollCause>('none')
  const holdRef = useRef<ActiveHold | null>(null)
  // Set while we move the position ourselves, so our own scroll events aren't
  // read as the reader moving away from the end.
  const programmaticRef = useRef(false)
  // Re-entrancy lock for the fill check. A ref, not state, so asking the
  // question cannot itself cause a render that re-asks it.
  const fillingRef = useRef(false)
  const quietFrameRef = useRef<number | null>(null)

  const topBlockIdRef = useRef(topBlockId)
  topBlockIdRef.current = topBlockId
  const sessionRef = useRef(session)
  sessionRef.current = session

  const runProgrammatic = useCallback((mutate: () => void) => {
    programmaticRef.current = true
    mutate()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticRef.current = false
      })
    })
  }, [])

  const endHold = useCallback(() => {
    holdRef.current = null
    if (causeRef.current === 'loading-older') {
      causeRef.current = 'none'
    }
    if (quietFrameRef.current !== null) {
      cancelAnimationFrame(quietFrameRef.current)
      quietFrameRef.current = null
    }
  }, [])

  // A frame passing with no resize is what "settled" means, and it is the
  // expected way a hold ends. Armed only from the ResizeObserver and only once
  // corrections have started: before the page lands nothing is settling, and an
  // idle frame during the fetch would end the hold before it ever did anything.
  const armQuiescence = useCallback(() => {
    if (quietFrameRef.current !== null) {
      cancelAnimationFrame(quietFrameRef.current)
    }
    quietFrameRef.current = requestAnimationFrame(() => {
      quietFrameRef.current = null
      endHold()
    })
  }, [endHold])

  const beginHold = useCallback(() => {
    const root = viewport()
    if (!root) {
      return
    }
    const id = topBlockIdRef.current
    const anchorTop = id === null ? null : blockContentTop(root, id)
    // A new hold REPLACES one still settling; it never merges. Two live holds
    // would correct toward two different positions on the same commit, which is
    // the class of bug this controller exists to remove.
    endHold()
    holdRef.current = {
      state: {
        anchor: id !== null && anchorTop !== null ? { id, top: anchorTop } : null,
        bottomDistance: root.scrollHeight - root.scrollTop - root.clientHeight,
      },
      settlingSince: null,
      viewportTop: id === null ? null : blockViewportTop(root, id),
    }
    causeRef.current = 'loading-older'
  }, [viewport, endHold])

  // One step of the continuous correction: re-assert the held invariant against
  // the layout as it is now.
  const stepHold = useCallback(() => {
    const active = holdRef.current
    const root = viewport()
    if (!active || !root) {
      return
    }
    const anchorId = active.state.anchor?.id
    const { shift, hold } = holdStep(active.state, {
      anchorTop: anchorId === undefined ? null : blockContentTop(root, anchorId),
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    })
    active.state = hold
    if (shift === null) {
      return
    }
    if (active.settlingSince === null) {
      // TEMPORARY: on the FIRST correction of a
      // prepend, report whether the browser already corrected it by itself. The
      // anchor moves through the content by the height inserted above it; it
      // moves on screen by that same amount MINUS whatever the browser already
      // absorbed. The gap between the two is the browser's own adjustment.
      reportBrowserScrollAdjustment(
        shift,
        active.viewportTop,
        anchorId === undefined ? null : blockViewportTop(root, anchorId),
      )
      active.settlingSince = performance.now()
    } else if (holdExpired(active.settlingSince, performance.now())) {
      reportHoldDeadline()
      endHold()
      return
    }
    // Relative, never `scrollTop = x`. Chromium snaps written scroll offsets to
    // physical pixels, so at a non-integral devicePixelRatio or under zoom the
    // value read back differs from the one written, and a held position writes
    // repeatedly — which is exactly where that error would accumulate.
    runProgrammatic(() => {
      root.scrollBy(0, shift)
    })
  }, [viewport, runProgrammatic, endHold])

  // Ask whether more history is needed, and fetch if so. Safe to call as often
  // as we like — that is the point of a level check — so it is driven from
  // everywhere the answer can change.
  const maybeFill = useCallback(() => {
    const root = viewport()
    if (!root || fillingRef.current) {
      return
    }
    const current = sessionRef.current
    const first = firstBlockRef.current
    const state = {
      hasMore: current.hasMoreHistory === true,
      loading: current.loadingMoreHistory === true,
      geometry: first
        ? {
            scrollTop: root.scrollTop,
            clientHeight: root.clientHeight,
            firstBlockContentTop: elementContentTop(root, first),
          }
        : null,
    }
    if (!shouldFill(state)) {
      return
    }
    fillingRef.current = true
    beginHold()
    void Promise.resolve(current.loadMoreHistory?.()).finally(() => {
      fillingRef.current = false
      // Two frames: one for React to commit the page, one to see whether that
      // commit put anything above the reader. If it didn't, the hold has
      // nothing to hold and would otherwise sit there until its deadline.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (holdRef.current?.settlingSince === null) {
            endHold()
          }
          // Coalesced re-run: the answer may still be yes, and the commit that
          // released the lock has already happened by now.
          maybeFill()
        })
      })
    })
  }, [viewport, beginHold, endHold])

  // THE apply step. One decision, one write. Called on every commit and from
  // the ResizeObserver, because content can change size without a commit.
  const applyDecision = useCallback(() => {
    const root = viewport()
    if (!root) {
      return
    }
    switch (decideScrollAction(causeRef.current, atBottomRef.current)) {
      case 'jump-bottom':
        // A held position belonged to the conversation being left.
        endHold()
        causeRef.current = 'none'
        atBottomRef.current = true
        runProgrammatic(() => {
          root.scrollTop = root.scrollHeight
        })
        break
      case 'follow-bottom': {
        // Skip a write that changes nothing. This runs on every commit, and a
        // streaming reply commits on every chunk — so writing unconditionally
        // would mark two frames as "ours" almost continuously, and the scroll
        // listener ignores those frames. The reader scrolling up mid-reply
        // would go unnoticed.
        //
        // Compared with a 1px tolerance, never for equality: scrollTop is a
        // double while scrollHeight and clientHeight are integers in the CSSOM
        // View IDL, so the target is only ever approached, not reached.
        if (root.scrollHeight - root.clientHeight - root.scrollTop > 1) {
          // Absolute is right here: there is no delta to preserve, the target
          // is the end of the content itself and the browser clamps it.
          runProgrammatic(() => {
            root.scrollTop = root.scrollHeight
          })
        }
        break
      }
      case 'hold-position':
        stepHold()
        break
      case 'none':
        break
    }
  }, [viewport, runProgrammatic, endHold, stepHold])

  useEffect(() => {
    const root = viewport()
    if (!root) {
      return
    }
    let queued = false
    const onScroll = () => {
      if (!programmaticRef.current) {
        atBottomRef.current = isAtBottom({
          scrollTop: root.scrollTop,
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
        })
      }
      // Re-ask the fill question, throttled to a frame: `scroll` fires far more
      // often than layout changes, and our own corrections raise it too, so an
      // unthrottled handler would re-enter on the corrections it caused.
      if (queued) {
        return
      }
      queued = true
      requestAnimationFrame(() => {
        queued = false
        maybeFill()
      })
    }
    const onUserGesture = (event: Event) => {
      if (event.type === 'wheel' && (event as WheelEvent).deltaY < 0) {
        // Reading upward stops the bottom-follow immediately, so streaming
        // content can't yank the view back down.
        atBottomRef.current = false
      }
      // Only cancels a hold that has already started correcting. Before the
      // page lands there is nothing to fight over, and the anchor is measured
      // in content coordinates — so the reader's own scrolling is preserved by
      // construction rather than needing the hold dropped. Cancelling there
      // instead would abandon the correction for the most ordinary interaction
      // there is: scrolling up continuously through history.
      const active = holdRef.current
      if (active !== null && active.settlingSince !== null) {
        endHold()
      }
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    for (const type of USER_SCROLL_GESTURES) {
      root.addEventListener(type, onUserGesture, { passive: true })
    }
    return () => {
      root.removeEventListener('scroll', onScroll)
      for (const type of USER_SCROLL_GESTURES) {
        root.removeEventListener(type, onUserGesture)
      }
    }
  }, [viewport, maybeFill, endHold])

  // Content changing size under us: an image landing, a turn expanding, a
  // prepend finishing its measure. Observing the content wrapper rather than an
  // ancestor is deliberate — the ResizeObserver loop only delivers targets
  // deeper than the previous pass, so a shallower node defers its notification
  // by a frame, and a frame here is a visibly wrong scroll position.
  useEffect(() => {
    const content = rootRef.current
    if (!content) {
      return
    }
    // Reads and corrects scroll only, never resizes anything — resizing from
    // inside the callback is what would defer the next delivery.
    const observer = new ResizeObserver(() => {
      applyDecision()
      const active = holdRef.current
      if (active !== null && active.settlingSince !== null) {
        armQuiescence()
      }
      maybeFill()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [applyDecision, armQuiescence, maybeFill])

  // Declared before the effect that acts on causes, so the flag is already set
  // when that effect runs on this same commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionKey): the session changing IS the cause being recorded
  useLayoutEffect(() => {
    causeRef.current = 'session-changed'
  }, [sessionKey])

  // Every commit that changed the content — keyed on the blocks ARRAY, not on
  // a count of it. A page landing mid-turn merges into an existing block and
  // adds neither a block nor a message, so a count would skip the very commit
  // carrying it; the rebuilt array is what actually marks that commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies(blocks): re-run on the commit that changed the content, not because the body reads it
  useLayoutEffect(() => {
    applyDecision()
    maybeFill()
  }, [blocks, applyDecision, maybeFill])

  return { rootRef, firstBlockRef }
}

// Everything the session holds is mounted: the server window is the only one.
// A second window in blocks used to sit on top of it, and because its unit
// (folded blocks) didn't match the server's (events), the two could disagree
// about whether anything was left — which is how a scroll-up could load
// nothing at all. At 5 records a page the DOM grows only as fast as someone
// scrolls, so bounding it bought nothing that the mismatch didn't cost more.
// Stamped on each rendered block's root so the scroll restore can find a
// specific block in the DOM again after a prepend has shifted it.
const BLOCK_ID_ATTR = 'data-block-id'

// Where an element sits in the scrollable content — the coordinate the reader
// scrolling does not change, so only content actually inserted above it moves
// this number. The one measurement both the fill check and the held position
// are expressed in, so they cannot end up in different coordinate spaces.
function elementContentTop(root: HTMLElement, el: Element): number {
  return contentTop(el.getBoundingClientRect().top, root.getBoundingClientRect().top, root.scrollTop)
}

// The same, for a block found by id, or null if it isn't in the DOM.
function blockContentTop(root: HTMLElement, id: string): number | null {
  const el = root.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`)
  return el ? elementContentTop(root, el) : null
}

// TEMPORARY: the same block's position on SCREEN, as
// opposed to its position in the content. The difference between how far it
// moves in each is precisely the scroll adjustment the browser applied by
// itself, which is the thing we need to observe before turning it off.
function blockViewportTop(root: HTMLElement, id: string): number | null {
  const el = root.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`)
  return el ? el.getBoundingClientRect().top - root.getBoundingClientRect().top : null
}

// TEMPORARY — remove together with this measurement.
//
// Answers one question in one line: did the browser's own scroll anchoring
// already compensate for a prepend, so that our correction lands on top of it?
// Reports a verdict rather than numbers so it can be read at a glance.
let scrollProbesLeft = 3
function reportBrowserScrollAdjustment(
  contentShift: number,
  viewportTopBefore: number | null,
  viewportTopAfter: number | null,
): void {
  if (scrollProbesLeft <= 0 || viewportTopBefore === null || viewportTopAfter === null) {
    return
  }
  scrollProbesLeft -= 1
  const onScreenShift = viewportTopAfter - viewportTopBefore
  const browserApplied = contentShift - onScreenShift
  const verdict =
    Math.abs(browserApplied) < 1
      ? 'NO — the browser left it to us (our correction is the only one)'
      : 'YES — the browser already moved it, so our correction is a SECOND one'
  console.log(
    `[scroll-probe] browser already corrected this prepend? ${verdict}` +
      ` | browser moved ${browserApplied.toFixed(1)}px, content grew ${contentShift.toFixed(1)}px above the reader`,
  )
}

export function AgentChat({ session, emptyText, agentAvatar, agentName, defaultExpanded }: AgentChatProps) {
  const displayName = agentName ?? session.botName
  // Computed over the FULL message list, not the visible window: turn indices
  // (for edit/fork) must stay correct regardless of how much is rendered, and
  // folding/building is cheap next to the cost of actually rendering blocks.
  const blocks = useMemo(
    () => buildBlocks(session.messages, session.historyHeader?.index),
    [session.messages, session.historyHeader?.index],
  )
  // 0-based user-turn index per user block, so "fork from here" rewinds to it.
  const turnByBlock = useMemo(() => {
    const map = new Map<number, number>()
    let turn = -1
    blocks.forEach((block, index) => {
      if (block.kind === 'user') {
        turn += 1
        map.set(index, turn)
      }
    })
    return map
  }, [blocks])
  const edit = session.canFork === true ? session.editMessage : undefined
  const { rootRef, firstBlockRef } = useChatScroll({
    sessionKey: session.sessionKey,
    blocks,
    topBlockId: blocks[0]?.id ?? null,
    session,
  })
  const detailsCollapsedRef = useRef(!defaultExpanded)
  const onDetailsCollapseChange = useCallback((collapsed: boolean) => {
    detailsCollapsedRef.current = collapsed
  }, [])

  // Older content lives only on the server now, so this is the one condition.
  const hasOlder = session.hasMoreHistory === true

  // Carry each block's position into the grouping — turnByBlock and the "is
  // this the active turn" check are both keyed by it, and grouping otherwise
  // loses it. The React key stays the block id, which (unlike position)
  // survives a "load older" prepend unchanged.
  const sections = useMemo(
    () => groupIntoTurnSections(blocks.map((block, i) => ({ ...block, absoluteIndex: i }))),
    [blocks],
  )

  return (
    <Flex ref={rootRef} justify='end' className='min-h-full min-w-0 gap-3 px-4 py-4'>
      {session.loading ? (
        <div className='text-sm text-muted-foreground'>loading…</div>
      ) : session.messages.length === 0 ? (
        <div className='text-sm text-muted-foreground'>{emptyText ?? 'no messages yet'}</div>
      ) : (
        <>
          {hasOlder && (
            <div className='py-1 text-center text-xs text-muted-foreground'>
              {session.loadingMoreHistory ? 'loading older…' : '· · ·'}
            </div>
          )}
          {sections.map((section, sectionIndex) => (
            // One section per turn: the user message sticks to the top of the
            // viewport while its own replies scroll under it, and the next
            // turn's section pushes it out on the way past. Bounding each
            // header to its section is what produces that hand-off, so no
            // scroll position is read anywhere.
            <Flex
              key={section.id}
              // The fill check measures from the first real block, so the
              // loading indicator above it cannot satisfy the condition that
              // produced it.
              ref={sectionIndex === 0 ? firstBlockRef : undefined}
              className='w-full min-w-0 gap-3'
            >
              {section.user ? (
                <UserMessage
                  sticky
                  blockId={section.user.id}
                  text={section.user.text}
                  editDisabled={session.waiting}
                  onEdit={
                    edit && section.user
                      ? () => edit(turnByBlock.get(section.user?.absoluteIndex ?? 0) ?? 0, section.user?.text ?? '')
                      : undefined
                  }
                />
              ) : (
                // Only the first section can lack a question: the window starts
                // inside a turn whose own `user` event is above it. The server
                // hands that text over separately so this turn still reads as a
                // question with replies rather than as replies to nothing.
                // Not editable — the message it refers to isn't loaded.
                sectionIndex === 0 &&
                session.historyHeader && <UserMessage sticky blockId='u:header' text={session.historyHeader.text} />
              )}
              {section.items.map((b) =>
                b.kind === 'user' ? null : (
                  <Details
                    key={b.id}
                    blockId={b.id}
                    items={b.items}
                    botName={displayName}
                    agentAvatar={agentAvatar}
                    defaultCollapsed={detailsCollapsedRef.current}
                    onCollapseChange={onDetailsCollapseChange}
                    pending={b.absoluteIndex === blocks.length - 1 && session.waiting}
                  />
                ),
              )}
            </Flex>
          ))}
        </>
      )}
      {session.waiting && <ThinkingIndicator />}
      <AgentChatStatusIndicators />
    </Flex>
  )
}

function UserMessage({
  blockId,
  text,
  editDisabled,
  onEdit,
  sticky,
}: {
  // Marks this block in the DOM so the load-older restore can find it again
  // and measure how far it moved. Sits on the outermost box, which is the
  // block's own element in the flow.
  blockId: string
  text: string
  editDisabled?: boolean
  onEdit?: () => void
  // Hold the top of the viewport while this turn's replies scroll underneath.
  // Needs an opaque background, since replies pass behind it.
  //
  // These classes belong on the OUTERMOST element, outside the rail: otherwise
  // the avatar scrolls away while the message stays, and the background stops
  // short of the rail so replies show through beside it.
  //
  // `z-1` is exact, not a round number, and both bounds are load-bearing:
  //  - It must exceed the replies. Each one wraps its entries in a `relative`
  //    box, and a positioned box with an automatic z-index sits at 0 and comes
  //    later in the document — so anything lower loses to it on tree order and
  //    the replies paint over the header.
  //  - It must not exceed the composer, which is also `z-1` and later in the
  //    document still. Equal values are broken by tree order, so the composer
  //    keeps painting over the header, which is what a raised value broke.
  // No integer sits between those, which is why matching the composer rather
  // than clearing it is the fix.
  sticky?: boolean
}) {
  return (
    // The same rail the replies below are rendered in, so both columns start at
    // the same left edge by construction rather than by a matched indent — if
    // the rail's width changes, the two move together. The avatar has no source
    // yet and falls back to a person icon, which is the intended placeholder.
    //
    // The rail's own `py-2` is what spaces the message from the viewport edge
    // once stuck, so the `pt-2 -mt-2` pair this used to carry is gone rather
    // than added to: keeping both would have doubled the gap. Unstuck, that
    // padding is the same rhythm every reply already has.
    <div
      // `container-type: scroll-state` makes this queryable as a stuck element.
      // It applies no containment — unlike the size container types, which add
      // style and size containment plus an independent formatting context — so
      // it cannot disturb the header's box (CSS Conditional 5).
      className={cn(sticky && 'sticky top-0 z-1 [container-type:scroll-state]')}
      {...{ [BLOCK_ID_ATTR]: blockId }}
    >
      {sticky && (
        // The header's backing: opaque down to mid-height, then falling away to
        // nothing at its bottom edge, so replies dissolve as they pass under it
        // instead of being clipped at a line.
        //
        // Spanning the element is what lets the falloff be this long. A layer
        // hanging BELOW the box — the previous approach — could never exceed the
        // gap to the next reply without tinting it in normal flow, which capped
        // it at 12px. This one is entirely inside the box, so it cannot reach
        // the reply at all and the cap doesn't apply.
        //
        // It costs no legibility even though it fades: the question sits in its
        // own `bg-muted` bubble and the avatar in a `bg-muted` circle, both
        // opaque in either theme, so nothing passes behind the text. This layer
        // only backs the gutter around them — the rail and the strip beside the
        // edit control — which is exactly what should dissolve.
        //
        // Opaque through the top half so the stuck message's own breathing room
        // (Chained's `py-2`) stays solid: the falloff begins below the text, not
        // above it.
        <div
          aria-hidden
          className='absolute inset-0 -z-1 pointer-events-none bg-linear-to-b from-background from-50% to-transparent'
        />
      )}

      <Chained marker={<AgentAvatar size='md' />} lineAbove={false} lineBelow={false} align='start'>
        <Flex row align='start' className='group w-full gap-1'>
          <Flex expanded className='relative gap-1.5 rounded-md bg-muted border-1 p-2'>
            {sticky && (
              // The stuck message's shadow — the command bar's, on the same
              // opaque rounded box the composer's card uses, so it floats on
              // the gradient rather than tracing a dissolving edge.
              //
              // Its own layer, matching the bubble's box by being its child,
              // because only opacity may animate: this appears and disappears
              // repeatedly as each header pushes the previous one out during a
              // single scroll, and a transitioned box-shadow would repaint
              // every time. Behind the bubble's background, which hides
              // nothing — an outer shadow is drawn outside the border box.
              //
              // No support guard is needed. Where scroll-state queries are
              // unavailable the declaration on the container is dropped and the
              // query never matches, so this simply stays at opacity 0 and the
              // header renders as it did before. Currently that means the
              // shadow appears in Chromium only.
              <div
                aria-hidden
                className='absolute inset-0 -z-1 rounded-md pointer-events-none shadow-lg shadow-black/50 opacity-0 transition-opacity duration-150 motion-reduce:transition-none [@container_scroll-state(stuck:top)]:opacity-100'
              />
            )}
            <div className='prose-chat'>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          </Flex>
          {onEdit && (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100'
              title='Edit message'
              disabled={editDisabled}
              onClick={onEdit}
            >
              <Pencil className='size-3.5' />
            </Button>
          )}
        </Flex>
      </Chained>
    </div>
  )
}

function toolDotVariant(item: DetailItem): ChainDotVariant {
  if (item.kind !== 'tool' || !item.result) {
    return 'default'
  }
  return item.result.isError ? 'destructive' : 'success'
}

// A registered tool view (see components/tool-views) renders in place of the
// generic block, giving e.g. remote_edit/edit_node_property a real diff
// instead of a raw args dump. Falls back to the same chrome without a target
// line otherwise (e.g. an external MCP server's tool, with no node/handle to
// point at).
function ToolCallView({ item }: { item: Extract<DetailItem, { kind: 'tool' }> }) {
  const spec = lookupToolView(item.name)
  const args = (item.args ?? {}) as Record<string, unknown>
  if (spec) {
    const ViewComponent = spec.body
    return <ViewComponent tool={item.name} args={args} requestId={item.id} mode='history' result={item.result} />
  }
  return <GenericToolView tool={item.name} args={args} result={item.result} />
}

type DetailEntry = { kind: 'header' } | { kind: 'item'; item: DetailItem }

function withHeader(items: DetailItem[]): DetailEntry[] {
  const entries: DetailEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0] && items[0].kind !== 'assistant-text') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

function Details({
  blockId,
  items,
  botName,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
  pending,
}: {
  blockId: string
  items: DetailItem[]
  botName: string
  agentAvatar?: string
  defaultCollapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  // True while this turn is the active turn and still generating.
  pending?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)
  const entries = withHeader(items)
  const toggle =
    items.length > 1 ? (
      <DetailsToggleButton
        collapsed={collapsed}
        onToggle={() => {
          const next = !collapsed
          setCollapsed(next)
          onCollapseChange?.(next)
        }}
      />
    ) : null

  // When collapsed, combine last text + last tool call (if tool comes AFTER text)
  if (collapsed) {
    // Find the last assistant-text entry
    let lastTextEntry: DetailEntry | null = null
    let lastTextIdx = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'item' && e.item.kind === 'assistant-text' && e.item.text.trim()) {
        lastTextEntry = e
        lastTextIdx = i
        break
      }
    }

    // Find the last tool entry that comes AFTER the last text
    let lastToolAfterText: DetailItem | null = null
    if (lastTextIdx >= 0) {
      for (let i = entries.length - 1; i > lastTextIdx; i--) {
        const e = entries[i]
        if (e.kind === 'item' && e.item.kind === 'tool') {
          lastToolAfterText = e.item
          break
        }
      }
    }

    const hasAvatar = !!agentAvatar
    const marker = hasAvatar ? <AgentAvatar avatar={agentAvatar} name={botName} size='md' /> : <ChainDot />

    return (
      <Flex className='min-w-0 w-full' {...{ [BLOCK_ID_ATTR]: blockId }}>
        <Chained marker={marker} lineAbove={false} lineBelow={false} align={hasAvatar ? 'start' : 'center'}>
          <Flex className='min-w-0 w-full gap-1'>
            <Flex row className='items-center justify-between w-full'>
              <div className='text-xs font-medium text-foreground'>{botName}</div>
              {toggle}
            </Flex>
            {/* Text — no animation, stable */}
            {lastTextEntry &&
              lastTextEntry.kind === 'item' &&
              lastTextEntry.item.kind === 'assistant-text' &&
              lastTextEntry.item.text.trim() && (
                <div className='prose-chat'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{lastTextEntry.item.text}</ReactMarkdown>
                </div>
              )}
            {/* Tool call — animate on changes */}
            {lastToolAfterText && (
              <div key={lastToolAfterText.id}>
                <ToolCallView item={lastToolAfterText} />
              </div>
            )}
            {/* If no text entry found, show the very last entry */}
            {!lastTextEntry &&
              (() => {
                const last = entries[entries.length - 1]
                if (last?.kind === 'item') {
                  if (last.item.kind === 'tool') {
                    return <ToolCallView item={last.item} />
                  }
                  if (last.item.kind === 'assistant-text') {
                    return last.item.text.trim() ? (
                      <div className='prose-chat'>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{last.item.text}</ReactMarkdown>
                      </div>
                    ) : null
                  }
                }
                return null
              })()}
          </Flex>
        </Chained>
      </Flex>
    )
  }

  return (
    <Flex className='min-w-0 w-full relative' {...{ [BLOCK_ID_ATTR]: blockId }}>
      {entries.map((entry, i) => {
        const isFirst = i === 0
        const isLast = i === entries.length - 1
        const hasAvatar = isFirst && !!agentAvatar
        const marker = hasAvatar ? (
          <AgentAvatar avatar={agentAvatar} name={botName} size='md' />
        ) : (
          <ChainDot variant={entry.kind === 'item' ? toolDotVariant(entry.item) : 'default'} />
        )
        return (
          <Chained
            key={i}
            marker={marker}
            lineAbove={!isFirst}
            lineBelow={!isLast}
            align={hasAvatar ? 'start' : 'center'}
          >
            {renderEntry(entry, isFirst ? botName : undefined, isFirst ? toggle : undefined, isLast && pending)}
          </Chained>
        )
      })}
    </Flex>
  )
}

function DetailsToggleButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? Maximize2 : Minimize2
  return (
    <button
      type='button'
      onClick={onToggle}
      className={cn(
        'shrink-0 size-6 inline-flex items-center justify-center rounded-md transition-colors',
        collapsed
          ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      )}
      title={collapsed ? 'Show details' : 'Hide details'}
    >
      <Icon className='size-3.5' />
    </button>
  )
}

function renderEntry(entry: DetailEntry, botName?: string, toggle?: React.ReactNode, pending?: boolean) {
  if (entry.kind === 'header') {
    return <AssistantText text='' botName={botName} toggle={toggle} />
  }
  const { item } = entry
  if (item.kind === 'assistant-text') {
    return <AssistantText text={item.text} botName={botName} toggle={toggle} />
  }
  if (item.kind === 'thinking') {
    return <ThinkingBlock text={item.text} pending={pending} />
  }
  return <ToolCallView item={item} />
}

function AssistantText({ text, botName, toggle }: { text: string; botName?: string; toggle?: React.ReactNode }) {
  return (
    <Flex className='min-w-0 w-full gap-1'>
      <Flex row className='items-center justify-between w-full'>
        {botName ? <div className='text-xs font-medium text-foreground'>{botName}</div> : null}
        {toggle}
      </Flex>
      {text ? (
        <div className='prose-chat'>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      ) : null}
    </Flex>
  )
}

const THINKING_PHRASES = [
  'Analyzing...',
  'Architecting...',
  'Brewing...',
  'Casting...',
  'Consulting...',
  'Cooking...',
  'Crunching...',
  'Doing the THING...',
  'Figuring...',
  'Masterminding...',
  'Orchestrating...',
  'Pondering...',
  'Processing...',
  'Slacking...',
  'Snoozing...',
  'Sorcering...',
  'Thinking...',
  'Vibing...',
  'Witching...',
  'Working...',
] as const

export function ThinkingIndicator() {
  const [phrase, setPhrase] = useState<string>(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
  )
  const prevPhrase = useRef(phrase)
  const [visible, setVisible] = useState(0)

  // Cycle phrases
  useEffect(() => {
    const interval = setInterval(() => {
      let next: string
      do {
        next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
      } while (next === phrase && next.length === phrase.length && THINKING_PHRASES.length > 1)
      prevPhrase.current = phrase
      setPhrase(next)
      setVisible(0)
    }, 3000)
    return () => clearInterval(interval)
  }, [phrase])

  const maxLen = Math.max(phrase.length, prevPhrase.current.length)

  // Typewriter effect
  useEffect(() => {
    let i = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) {
        return
      }
      i++
      if (i <= maxLen) {
        setVisible(i)
        setTimeout(tick, 20 + Math.random() * 60)
      }
    }
    setTimeout(tick, 300)
    return () => {
      cancelled = true
    }
  }, [phrase])

  // Compose display: new text overwrites old character by character
  const paddedNew = phrase.padEnd(maxLen)
  const paddedOld = prevPhrase.current.padEnd(maxLen)
  const display = paddedNew.slice(0, visible) + paddedOld.slice(visible)

  return (
    <Flex row align='center' className='gap-2 text-xs text-muted-foreground font-mono'>
      <TypingDots variant='primary' size='sm' />
      <span>{display.trimEnd()}</span>
    </Flex>
  )
}

// Messages held in the session's server-side queue (typed while a turn was
// running, delivered in order as turns end). Rendered inside the command bar so
// the feedback sits directly above the composer that produced the messages.
function QueuedMessages({ items, onRemove }: { items: QueuedPrompt[]; onRemove: (id: string) => void }) {
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      {items.map((m) => (
        <div key={m.id} className='flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs'>
          <span className='shrink-0 text-muted-foreground'>Queued</span>
          {/* Queued text is already transformed for the agent (system/context
              tags applied at send time); show only the user's own words, same
              as delivered user bubbles. */}
          <span className='min-w-0 flex-1 truncate'>{stripOpencroftTags(m.text)}</span>
          <button
            type='button'
            onClick={() => onRemove(m.id)}
            className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
            title='Remove from queue'
          >
            <X className='size-3.5' />
          </button>
        </div>
      ))}
    </div>
  )
}

interface AgentChatInputProps {
  session: AgentSession
  /** Active agent's node id. When set, extension-provided input controls (e.g.
   *  voice) declared for the `agent-chat-input-controls` point are rendered. */
  agentNodeId?: string
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  /** Extra content rendered at the start of the command bar (left of sparkles icon). */
  leadingBarContent?: React.ReactNode
  /** Rendered in the command-bar menu (e.g. a session picker shown on focus). The
   * caller decides when it's non-null. */
  focusMenu?: React.ReactNode
  /** When set, the Sparkles start icon becomes a button that runs this (e.g. open
   * the session picker). Must be stable — it feeds the memoized command bar. */
  onStartIconClick?: () => void
  /** Messages held in the session's server-side queue while a turn runs. They
   * render inside the published bar, above the input row, so the "your message
   * is held" feedback appears wherever the composer itself is shown. */
  queued?: QueuedPrompt[]
  /** Drop a still-queued message before delivery. Must be stable — it feeds the
   * memoized command bar. */
  onRemoveQueued?: (id: string) => void
  /** The session's agent-advertised config options (model/effort/mode/…) —
   * rendered as selectors below the input row. Empty for adapters that don't
   * advertise any. */
  configOptions?: SessionConfigOption[]
  /** Change one of the session's config options. Must be stable — it feeds the
   * memoized command bar. */
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  /** Context usage meter (tokens used / window), shown alongside the selectors. */
  usage?: { used: number; size?: number }
  /** This session's persisted composer draft, loaded once when the session
   * (identified by `session.sessionKey`) opens. Distinct from `session.draft`
   * (edit-message staging). */
  savedDraft?: string
  /** Save (or clear, with '') the given session's draft. Debounced internally;
   * called with the session key so a flush during a session switch always
   * targets the session the text actually belongs to. */
  onDraftChange?: (key: string, text: string) => void
}

// Debounce composer draft saves so normal typing doesn't POST every keystroke.
// Flushed immediately (bypassing this delay) on send and on session switch.
const DRAFT_SAVE_DEBOUNCE_MS = 600

export function AgentChatInput({
  session,
  agentNodeId,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  leadingBarContent,
  focusMenu,
  onStartIconClick,
  queued,
  onRemoveQueued,
  configOptions,
  onSetConfigOption,
  usage,
  savedDraft,
  onDraftChange,
}: AgentChatInputProps) {
  // Lazy init so a session opened with an existing draft paints with it
  // already in place — no separate fetch-then-fill flicker, since the parent
  // already has `savedDraft` (from the same sessions payload/SSE stream that
  // gated rendering this composer at all) before this component ever mounts.
  const [text, setText] = useState(() => savedDraft ?? '')
  const [autoApprove, setAutoApproveState] = useState(false)
  const [yoloMode, setYoloMode] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    getAutoApprove().then(setAutoApproveState)
    fetch('/api/yolo')
      .then((r) => r.json())
      .then(({ enabled }) => setYoloMode(enabled))
      .catch(() => {})
  }, [])

  // Editing a user message stages its text as a draft — load it into the
  // composer and focus so it's ready to revise and re-send.
  useEffect(() => {
    if (session.draft) {
      setText(session.draft.text)
      textareaRef.current?.focus()
    }
  }, [session.draft])

  // This component isn't remounted when the user switches sessions (only
  // `session` prop changes), so the composer's own text has to be swapped
  // manually on a sessionKey change: flush whatever was pending for the
  // OUTGOING session first (so its last few keystrokes aren't lost or,
  // worse, saved under the wrong session), then load the incoming session's
  // saved draft. A layout effect (not a plain effect) so the swap happens
  // before paint — otherwise the outgoing session's stale text would flash
  // in the composer for a frame under the new session's header.
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef<{ key: string; text: string } | null>(null)
  const sessionKeyRef = useRef(session.sessionKey)

  const flushPendingDraft = useCallback(() => {
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
      draftDebounceRef.current = null
    }
    const pending = pendingDraftRef.current
    if (pending) {
      pendingDraftRef.current = null
      onDraftChangeRef.current?.(pending.key, pending.text)
    }
  }, [])

  useLayoutEffect(() => {
    if (sessionKeyRef.current === session.sessionKey) {
      return
    }
    flushPendingDraft()
    sessionKeyRef.current = session.sessionKey
    setText(savedDraft ?? '')
    // biome-ignore lint/correctness/useExhaustiveDependencies(savedDraft): only read at the moment sessionKey changes, not on every savedDraft echo (e.g. from this same composer's own debounced save)
  }, [session.sessionKey, flushPendingDraft])

  // Flush on unmount (e.g. navigating away entirely) so the very last
  // keystrokes before the debounce would have fired aren't dropped.
  useEffect(() => () => flushPendingDraft(), [flushPendingDraft])

  const onChangeText = useCallback((value: string) => {
    setText(value)
    const key = sessionKeyRef.current
    pendingDraftRef.current = { key, text: value }
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
    }
    draftDebounceRef.current = setTimeout(() => {
      draftDebounceRef.current = null
      const pending = pendingDraftRef.current
      if (pending) {
        pendingDraftRef.current = null
        onDraftChangeRef.current?.(pending.key, pending.text)
      }
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }, [])

  // Extension-provided input controls (e.g. voice) get a stable context: insert
  // transcribed text into the composer, send a message, or read the live reply
  // stream — all via stable refs so the memoized command bar below doesn't churn.
  // Routed through onChangeText (not a raw setText) so voice-inserted text is
  // draft-tracked the same as typed text; reads `text` via a ref (not a dep) so
  // this callback's own identity stays stable.
  const textRef = useRef(text)
  textRef.current = text
  const insertText = useCallback(
    (piece: string) => {
      const value = piece.trim()
      if (value) {
        const prev = textRef.current
        onChangeText(prev ? `${prev} ${value}` : value)
      }
    },
    [onChangeText],
  )
  const sendRef = useRef(session.send)
  sendRef.current = session.send
  const messagesRef = useRef(session.messages)
  messagesRef.current = session.messages
  const sendMessage = useCallback((value: string) => sendRef.current(value), [])
  const getMessages = useCallback(() => messagesRef.current, [])
  const voiceControls = useMemo(
    () =>
      agentNodeId ? (
        <AgentChatInputControls
          agentNodeId={agentNodeId}
          insertText={insertText}
          send={sendMessage}
          getMessages={getMessages}
          streaming={session.waiting}
        />
      ) : null,
    [agentNodeId, insertText, sendMessage, getMessages, session.waiting],
  )

  const toggleAutoApprove = async () => {
    const next = await setAutoApprove({ data: !autoApprove })
    setAutoApproveState(next)
  }

  const inputPlaceholder = placeholder ?? `Message ${shortKey(session.sessionKey)}…`

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || session.sending || session.disabled) {
      return
    }
    setText('')
    session.send(value)
    // Clear immediately — bypass the debounce, don't wait for a stray timer to
    // resave the now-stale pending text over this.
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
      draftDebounceRef.current = null
    }
    pendingDraftRef.current = null
    onDraftChangeRef.current?.(sessionKeyRef.current, '')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(event)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setText('')
    }
  }

  // The wrapper column is rendered even with an empty queue so the bar's
  // element structure (and thus the Textarea's identity) never changes when
  // messages queue up or drain — a shape change would remount the composer and
  // drop its focus mid-typing.
  const barNode = useMemo(
    () => (
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        {queued && queued.length > 0 && onRemoveQueued && <QueuedMessages items={queued} onRemove={onRemoveQueued} />}
        <div className='flex min-w-0 items-start gap-2'>
          {leadingBarContent}
          {onStartIconClick ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='h-7 w-7 shrink-0 mt-0.5'
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStartIconClick}
              title='Sessions'
            >
              <Sparkles className='h-4 w-4 text-primary' />
            </Button>
          ) : (
            <Sparkles className='h-4 w-4 ml-1 mt-1.5 shrink-0 text-primary' />
          )}
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={inputPlaceholder}
            rows={1}
            autoFocus={autoFocus}
            className='min-h-8 max-h-60 border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent resize-none py-1.5'
          />
          {voiceControls}
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-7 w-7 shrink-0 mt-0.5'
            onMouseDown={(e) => e.preventDefault()}
            onClick={yoloMode ? undefined : toggleAutoApprove}
            disabled={yoloMode}
            title={
              yoloMode
                ? 'YOLO Mode — all MCP tool approvals skipped (set via OPENCROFT_YOLO_MODE env or /settings?section=audit)'
                : autoApprove
                  ? 'Auto-approve ON — all MCP tool calls approved automatically (click to require approval)'
                  : 'Auto-approve OFF — MCP tool calls require approval (click to auto-approve)'
            }
          >
            {yoloMode ? (
              <ShieldAlert className='h-4 w-4 text-red-500 animate-pulse' />
            ) : autoApprove ? (
              <ShieldCog className='h-4 w-4 text-amber-500' />
            ) : (
              <ShieldCheck className='h-4 w-4 text-primary' />
            )}
          </Button>
          {session.waiting && session.stop ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='h-7 w-7 shrink-0 mt-0.5'
              onMouseDown={(e) => e.preventDefault()}
              onClick={session.stop}
              title='Stop'
            >
              <Square className='h-4 w-4' />
            </Button>
          ) : (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='h-7 w-7 shrink-0 mt-0.5'
              onMouseDown={(e) => e.preventDefault()}
              onClick={submit}
              disabled={!text.trim() || session.sending || session.disabled}
            >
              <SendIcon className='h-4 w-4' />
            </Button>
          )}
        </div>
        {configOptions && onSetConfigOption && (
          // ConfigOptionsBar itself renders nothing when there's no config
          // option and no usage to show — this only decides whether the props
          // to check for that are even wired up.
          <ConfigOptionsBar
            options={configOptions}
            onSetOption={onSetConfigOption}
            usage={usage}
            className='flex-wrap gap-2 px-1 pb-0.5 text-xs text-muted-foreground'
          />
        )}
      </div>
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ),
    [
      leadingBarContent,
      onStartIconClick,
      text,
      session.sending,
      session.waiting,
      session.stop,
      session.disabled,
      inputPlaceholder,
      autoFocus,
      autoApprove,
      voiceControls,
      queued,
      onRemoveQueued,
      configOptions,
      onSetConfigOption,
      usage,
    ],
  )

  useOverlay({ menu: focusMenu ?? null, bar: barNode })

  return null
}

// ── Extension-provided chat-input controls (e.g. voice) ──────────────────────
// Core owns only the injection point and this contract. The actual controls
// (mic capture, TTS playback) live in an extension that declares
// `provides: { 'agent-chat-input-controls': [{ id, component }] }` and resolves
// the agent's ASR/TTS config server-side from `agentNodeId`. Core never
// references any specific extension.
export interface AgentVoiceControlProps {
  /** The active agent's node id; the control resolves its ASR/TTS config from it. */
  agentNodeId: string
  /** Append transcribed text to the composer draft. */
  insertText: (text: string) => void
  /** Send a message as the user. */
  send: (text: string) => void
  /** Read the live message list (e.g. to speak the latest reply). */
  getMessages: () => ChatMessage[]
  /** True while the agent is generating a reply; flips false when the turn completes. */
  streaming: boolean
}

export interface AgentChatInputControl {
  id: string
  component: ComponentType<AgentVoiceControlProps>
}

function AgentChatInputControls(props: AgentVoiceControlProps) {
  const { items } = useProvided<AgentChatInputControl>('agent-chat-input-controls', loadAllExtensions)
  return (
    <>
      {items.map((control) => (
        <control.component key={control.id} {...props} />
      ))}
    </>
  )
}

// ── Extension-provided chat status indicators (e.g. voice visualizer) ─────────
// Rendered at the foot of the message list, alongside the thinking indicator.
// Each component mounts continuously and decides its own visibility (e.g. a TTS
// playback visualizer that only appears while audio is playing). Same pattern as
// the input controls above — core owns only the injection point, no extension is
// referenced by name.
export interface AgentChatStatusIndicator {
  id: string
  component: ComponentType
}

function AgentChatStatusIndicators() {
  const { items } = useProvided<AgentChatStatusIndicator>('agent-chat-status-indicators', loadAllExtensions)
  return (
    <>
      {items.map((indicator) => (
        <indicator.component key={indicator.id} />
      ))}
    </>
  )
}

function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}
