'use client'

import type { ReactNode } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'

import { ChatEmptyState } from './chat-empty-state'
import {
  BLOCK_ID_ATTR,
  ChatLoadOlderButton,
  ChatTurnDetails,
  type ChatTurnRenderers,
  ChatUserMessage,
  type ChatUserMessagePart,
  type DetailItem,
  type UserText,
} from './chat-turn'

// `id` is the React key, and it has to name the same block before and after a
// "load older" prepend -- otherwise React rewrites DOM across the visible
// range and the scroll restore loses the element it measures against.
//
// A user block is named by its own message. A details block is named by the
// TURN it belongs to, not by whichever message happens to be first in the
// loaded slice: pages can land mid-turn, and consecutive agent messages fold
// into one block, so a page merging into the block above would otherwise
// rename it on every fetch. Naming it by the turn was always the honest
// identity -- a details block *is* one turn's replies -- and it only looked
// stable before because every page began at a turn boundary.
//
// A user block carries its turn twice, in two forms that answer different
// questions. `parts` is what renders: one message per author and send time.
// `text` is the turn exactly as the host handed it over, and it is what an edit
// puts back into the composer -- so it keeps whatever the host's own encoding
// left in it, because anything dropped there would be dropped from the message
// on the way back out, silently and with nothing to notice it by.
export type Block =
  | { id: string; kind: 'user'; text: UserText; parts: readonly ChatUserMessagePart[] }
  | { id: string; kind: 'details'; items: DetailItem[] }

// Each block carries its own position in the full `blocks` array, assigned
// once while grouping. `onEditUser`/`pending` both need "where is this in the
// whole conversation", and re-deriving that per block with `indexOf` inside
// the render would make a long conversation quadratic in its own length --
// exactly the case pagination exists to keep long.
type PositionedBlock = Block & { absoluteIndex: number }

interface TurnSection {
  id: string
  user?: Extract<PositionedBlock, { kind: 'user' }>
  items: PositionedBlock[]
}

// Groups a flat block list into one section per turn, so a turn's user message
// can be rendered as a `position: sticky` header over its own replies. The
// section boundary is what makes the next user message push the previous one
// out of the viewport: each header is constrained to its own section's box, so
// no scroll listener or offset arithmetic is involved.
//
// Internal rather than a host input: it is a pure fold over `blocks`, which the
// component already has, so asking the host to fold it first and hand back the
// result would be the same computation with a prop in the middle.
function groupIntoTurnSections(blocks: readonly Block[]): TurnSection[] {
  const sections: TurnSection[] = []
  blocks.forEach((block, absoluteIndex) => {
    const positioned: PositionedBlock = { ...block, absoluteIndex }
    if (positioned.kind === 'user') {
      sections.push({ id: positioned.id, user: positioned, items: [] })
      return
    }
    const current = sections[sections.length - 1]
    if (current) {
      current.items.push(positioned)
    } else {
      sections.push({ id: positioned.id, items: [positioned] })
    }
  })
  return sections
}

// ── scroll-intent: the one decision the scroller makes per commit ──────────
//
// Kept as its own section so the precedence between its cases stays directly
// readable, the way it was directly testable as its own module before the
// move.
//
// The rule is: decide from the REASON the update happened, once, and apply it
// in one place -- never by inspecting geometry afterwards and inferring what
// was wanted. The controller used to be several effects that each measured the
// DOM and each wrote scrollTop (follow-the-bottom on a content key, follow-
// the-bottom from a ResizeObserver, jump-to-bottom on session change, and a
// restore after a prepend). Every failure it had was two of them acting on the
// same commit and disagreeing. One enum cannot disagree with itself, so the
// guards that used to hold them apart -- and could be forgotten one at a time
// -- stop being needed rather than being made more careful.

// How close to the end still counts as "following the conversation". Wide
// enough to survive the +/-1px of rounding the CSSOM View IDL allows between
// scrollTop (a double) and scrollHeight/clientHeight (integers).
//
// Exported, with the handful of others below it, only so the reasoning this
// file carries stays directly testable -- see chat-conversation.test.ts. None
// of this is part of the component's props contract.
export const AT_BOTTOM_THRESHOLD = 32

// How close to the start of the content still counts as "hasn't moved since
// pressing the button". The same tolerance as the bottom edge and for the same
// reason: it absorbs the +/-1px of rounding plus a nudge, while staying too
// narrow to call a reader who has genuinely scrolled away "still at the top".
const AT_TOP_THRESHOLD = 32

// Where the reader ends up after they press "load older messages" -- a product
// decision, not a technical one, and this is the one line that flips it:
//
//  * false (shipped) -- the position is left alone, so the newly loaded
//    messages appear where the reader is looking and the click visibly did
//    something.
//  * true -- their place is kept instead: what they were reading stays put and
//    the new batch lands above it, so reading back through history is one
//    continuous upward motion. The cost is that the click looks inert until
//    they scroll up into what arrived.
export const LOAD_OLDER_KEEPS_POSITION = false

// Why the DOM is about to change. Set by whatever caused it, at the moment it
// causes it; 'none' means an ordinary update nobody claimed.
type ScrollCause = 'none' | 'session-changed' | 'loading-older'
type ScrollAction = 'none' | 'jump-bottom' | 'follow-bottom' | 'hold-position'

interface BottomGeometry {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

// Whether the reader is at the end of the conversation, and so should be
// carried along by new content.
export function isAtBottom(geometry: BottomGeometry): boolean {
  // A conversation too short to scroll counts as "at the end" outright, rather
  // than arriving there through arithmetic on a scrollTop that has no room to
  // vary -- the one case where the numbers are degenerate (every term near
  // zero) and so the one where a rounding or overscroll artefact can flip the
  // answer.
  if (geometry.scrollHeight <= geometry.clientHeight) {
    return true
  }
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= AT_BOTTOM_THRESHOLD
}

interface ScrollSituation {
  cause: ScrollCause
  // Where the reader was BEFORE this commit -- read from state the scroll
  // listener maintains, not measured after the content landed, because by
  // then the new content has already changed the answer.
  atBottom: boolean
  // Whether they are still at the start of the content, i.e. still looking at
  // the place the button was when they pressed it.
  atTop: boolean
}

// Named fields rather than positional arguments: three of the four inputs are
// booleans, and getting two of them the wrong way round is the kind of mistake
// that type-checks and then misbehaves only in one branch.
//
// `keepsPosition` defaults to the shipped constant and is a parameter, not a
// closure over it, purely so a test can exercise the other side of the
// decision without flipping the constant that is actually shipped.
export function decideScrollAction(
  situation: ScrollSituation,
  keepsPosition: boolean = LOAD_OLDER_KEEPS_POSITION,
): ScrollAction {
  switch (situation.cause) {
    // Switching conversations always lands at the end, whatever else was in
    // flight -- the position being held belonged to a chat that is now gone.
    case 'session-changed':
      return 'jump-bottom'
    // A prepend outranks following the bottom either way. The content grew
    // ABOVE the reader, so "there is more content now" is never a reason to
    // move to the end.
    case 'loading-older':
      // Under the shipped setting, doing nothing IS the behaviour -- but only
      // while the reader is still where the button was. Leaving the position
      // alone is what puts the new messages in front of them; correcting
      // would push those messages straight back out of sight.
      //
      // If they have scrolled away since pressing -- a slow fetch, a keyboard
      // press followed by a scroll -- doing nothing is no longer a reveal, it
      // is the content lurching under them by the height of everything that
      // arrived. So the correction is not vestigial when position is not
      // kept; it is what covers the case where that reasoning stops applying.
      return keepsPosition || !situation.atTop ? 'hold-position' : 'none'
    default:
      return situation.atBottom ? 'follow-bottom' : 'none'
  }
}

// ── scroll-restore: geometry for the "load older" restore ──────────────────
//
// The problem this solves: when a page of older messages is prepended, the
// content above the reader grows, and scrollTop must move by exactly that
// growth or the viewport jumps. Two things make that harder than it looks.
//
//  1. The prepend and the render-window growth can land as separate state
//     updates in separate places, so there is no guarantee about which commit
//     the measurement runs in relative to the content landing.
//  2. Content below the reader can change height on its own (markdown and
//     code blocks measure asynchronously), so any formula derived from the
//     container's total scrollHeight silently absorbs those changes too.
//
// Measuring one element that exists on both sides of the prepend, in content
// coordinates, is immune to both: the only thing that moves it is content
// inserted above it.

// Below this, "the content moved" cannot be distinguished from measurement
// noise, so the correction is skipped rather than applied.
//
// One pixel, not a smaller guess: `scrollHeight` and `clientHeight` are
// integers in the CSSOM View IDL while `scrollTop` is a double, so a position
// derived from them carries up to +/-1px of rounding -- and the spec pins no
// rounding mode, so engines may differ at the half-pixel.
//
// Skipping small corrections is a fix in its own right, not just an
// optimisation: writing a position that is already correct is what turns
// rounding into visible jitter.
export const EPSILON = 1

// A position in CONTENT coordinates -- distance from the top of the scrollable
// content -- derived from two viewport-relative rects and the current offset.
//
// Deliberately not `offsetTop`, which is measured against the nearest
// POSITIONED ancestor: this component is inside a Radix viewport and owns
// nothing about its positioning, so if the offset parent resolves further out
// the number silently becomes page-relative and every comparison against
// `scrollTop` measures across two coordinate spaces. Rects are
// container-relative by construction, and fractional where `offsetTop` is
// rounded to an integer.
function contentTop(elementRectTop: number, rootRectTop: number, scrollTop: number): number {
  return elementRectTop - rootRectTop + scrollTop
}

interface ScrollAnchor {
  // A block rendered both before and after the prepend. Its id names the turn
  // (or the user message), not a position, so a page landing mid-turn merges
  // into the block without renaming it and this still finds the element.
  id: string
  // Its offset from the top of the scrollable CONTENT (not the viewport) at
  // capture time -- robust to the reader scrolling between capture and
  // commit, since scrolling moves the viewport, not the content.
  top: number
}

// How far scrollTop must move to keep `anchor` visually in place, given where
// that same element sits now. Null means "not yet": either the anchor is not
// in the DOM, or nothing has been inserted above it in this commit -- in both
// cases the caller should keep the capture and wait for a later commit rather
// than consuming it against a layout that has not changed.
export function restoreShift(anchor: ScrollAnchor, currentTop: number | null): number | null {
  if (currentTop === null) {
    return null
  }
  const shift = currentTop - anchor.top
  return Math.abs(shift) < EPSILON ? null : shift
}

// A single correction cannot be right, which is why the one that shipped kept
// being nearly right. Markdown, code blocks and images above the reader finish
// laying out AFTER the commit that introduced them, so the height added above
// keeps growing for several frames. Measure-correct-forget lands on the first
// of those frames and every later one moves the reader. So the position is
// held: the same invariant is re-asserted on every commit and every resize
// until the content above stops changing.

// How long a hold may keep correcting. This is a valve, not the expected exit
// -- quiescence is. It exists so that a row which animates forever cannot hold
// a correction open forever, and a hold that ends this way is reported rather
// than absorbed, because it means something above the reader never settled.
export const HOLD_DEADLINE_MS = 500

export interface HoldState {
  // Primary: a block rendered on both sides of the prepend. Only content
  // inserted above it moves it, which is what makes it immune to the async
  // measuring happening everywhere else in the list.
  anchor: ScrollAnchor | null
  // Fallback, used only when the anchor block is not in the DOM: the distance
  // from the reader to the end of the content. It needs no element, but it
  // charges height changes BELOW the reader (a streaming reply growing) to
  // the correction, so it is second choice rather than the invariant.
  bottomDistance: number
}

interface HoldGeometry {
  anchorTop: number | null
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// One step of a held position: how far to scroll now, and the state to hold
// from next time.
//
// The two baselines behave differently on purpose, and getting this backwards
// double-applies every correction:
//
//   * The anchor MUST be re-baselined. It is measured in content coordinates,
//     and scrolling moves the viewport rather than the content -- so after the
//     correction the anchor still reads as displaced, and a second step would
//     apply the same shift again.
//   * `bottomDistance` MUST NOT be. It is the invariant itself: the correction
//     is what restores it, so the captured value stays the target.
export function holdStep(hold: HoldState, now: HoldGeometry): { shift: number | null; hold: HoldState } {
  if (hold.anchor && now.anchorTop !== null) {
    const shift = restoreShift(hold.anchor, now.anchorTop)
    if (shift === null) {
      return { shift: null, hold }
    }
    return { shift, hold: { ...hold, anchor: { id: hold.anchor.id, top: now.anchorTop } } }
  }
  const distance = now.scrollHeight - now.scrollTop - now.clientHeight
  const shift = distance - hold.bottomDistance
  return Math.abs(shift) < EPSILON ? { shift: null, hold } : { shift, hold }
}

// Measured from the first applied correction, not from when the fetch
// started: a slow request must not spend the budget that exists to bound how
// long the content takes to settle.
export function holdExpired(settlingSince: number, now: number): boolean {
  return now - settlingSince >= HOLD_DEADLINE_MS
}

function blockContentTop(root: HTMLElement, id: string): number | null {
  const el = root.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`)
  return el ? contentTop(el.getBoundingClientRect().top, root.getBoundingClientRect().top, root.scrollTop) : null
}

// A position being held across a prepend while the content above settles.
interface ActiveHold {
  state: HoldState
  // When corrections started, or null while the fetched page has yet to land.
  settlingSince: number | null
}

// Keys that move a scroll container rather than a caret. Space is included
// because it pages a scroller when focus isn't in a text field.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

let holdDeadlineReportsLeft = 3
function reportHoldDeadline(): void {
  if (holdDeadlineReportsLeft <= 0) {
    return
  }
  holdDeadlineReportsLeft -= 1
  console.warn(
    `[chat-conversation] gave up holding the reader's position after ${HOLD_DEADLINE_MS}ms —` +
      ' content above the reader never stopped changing size',
  )
}

// Everything that can move the conversation's scroll position, in one place.
//
// It used to be five: a pinned-state flag, a ResizeObserver, a content-key
// effect, a session-reset effect, and a separate restore effect in the
// container -- each measuring the DOM and each writing scrollTop, held apart
// by a gate every new path had to remember to consult. Every failure it had
// was two of them acting on one commit and disagreeing.
//
// Now there is one decision (decideScrollAction), taken from the reason the
// update happened, and one place that writes the position.
//
// What it needs to know is only the rendered content, in order, and the
// reader's own position in its own DOM -- so it takes `blocks` and a
// `sessionKey`, never the host's session object. The one thing it cannot
// decide -- whether there is more history, and fetching it -- is not here:
// the host calls `holdAcrossLoadOlder` with the fetch it wants run, and this
// only holds the reader's place while that runs.
function useConversationScroll(sessionKey: string, blocks: readonly Block[]) {
  const rootRef = useRef<HTMLDivElement>(null)
  const topBlockId = blocks[0]?.id ?? null

  const viewport = useCallback(
    () => rootRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null,
    [],
  )

  // Where the reader was BEFORE the commit being decided. Maintained by the
  // scroll listener, never measured after new content has landed -- by then
  // the content itself has changed the answer.
  const atBottomRef = useRef(true)
  const causeRef = useRef<ScrollCause>('none')
  const holdRef = useRef<ActiveHold | null>(null)
  // Set while we move the position ourselves, so our own scroll events aren't
  // read as the reader moving away from the end.
  const programmaticRef = useRef(false)
  const quietFrameRef = useRef<number | null>(null)
  const topBlockIdRef = useRef(topBlockId)
  topBlockIdRef.current = topBlockId

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
  // corrections have started: before the page lands nothing is settling, and
  // an idle frame during the fetch would end the hold before it ever did
  // anything.
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
    // would correct toward two different positions on the same commit, which
    // is the class of bug this controller exists to remove.
    endHold()
    holdRef.current = {
      state: {
        anchor: id !== null && anchorTop !== null ? { id, top: anchorTop } : null,
        bottomDistance: root.scrollHeight - root.scrollTop - root.clientHeight,
      },
      settlingSince: null,
    }
    causeRef.current = 'loading-older'
  }, [viewport, endHold])

  // One step of the continuous correction: re-assert the held invariant
  // against the layout as it is now.
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
      active.settlingSince = performance.now()
    } else if (holdExpired(active.settlingSince, performance.now())) {
      reportHoldDeadline()
      endHold()
      return
    }
    // Relative, never `scrollTop = x`. Chromium snaps written scroll offsets
    // to physical pixels, so at a non-integral devicePixelRatio or under zoom
    // the value read back differs from the one written, and a held position
    // writes repeatedly -- which is exactly where that error would
    // accumulate.
    runProgrammatic(() => {
      root.scrollBy(0, shift)
    })
  }, [viewport, runProgrammatic, endHold])

  // The primitive the host composes its own "load older" from: hold the
  // reader's position, run the given operation, and settle the hold once it
  // lands. Two frames after settling -- one for React to commit the page, one
  // to see whether that commit put anything above the reader -- because that
  // is a fact about rendering, not about fetching, so it stays with the
  // mechanism rather than being something every caller has to get right.
  const holdAcrossLoadOlder = useCallback(
    (operation: () => Promise<void> | undefined) => {
      beginHold()
      void Promise.resolve(operation()).finally(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (holdRef.current?.settlingSince === null) {
              endHold()
            }
          })
        })
      })
    },
    [beginHold, endHold],
  )

  // THE apply step. One decision, one write. Called on every commit and from
  // the ResizeObserver, because content can change size without a commit.
  const applyDecision = useCallback(() => {
    const root = viewport()
    if (!root) {
      return
    }
    // `atTop` is measured here rather than captured at the click on purpose: it
    // asks "is the reader still where the button was", and the answer can
    // change between pressing and the page landing.
    const situation = {
      cause: causeRef.current,
      atBottom: atBottomRef.current,
      atTop: root.scrollTop <= AT_TOP_THRESHOLD,
    }
    switch (decideScrollAction(situation)) {
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
        // streaming reply commits on every chunk -- so writing unconditionally
        // would mark two frames as "ours" almost continuously, and the scroll
        // listener ignores those frames. The reader scrolling up mid-reply
        // would go unnoticed.
        if (root.scrollHeight - root.clientHeight - root.scrollTop > 1) {
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

  useLayoutEffect(() => {
    const root = viewport()
    if (!root) {
      return
    }
    const onScroll = () => {
      if (!programmaticRef.current) {
        atBottomRef.current = isAtBottom({
          scrollTop: root.scrollTop,
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
        })
      }
    }
    // Only cancels a hold that has ALREADY started correcting. Before the page
    // lands there is nothing to fight over, and the anchor is measured in
    // content coordinates -- so the reader's own scrolling is preserved by
    // construction rather than needing the hold dropped.
    const cancelSettlingHold = () => {
      const active = holdRef.current
      if (active !== null && active.settlingSince !== null) {
        endHold()
      }
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        atBottomRef.current = false
      }
      cancelSettlingHold()
    }
    const onTouchMove = () => cancelSettlingHold()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) {
        cancelSettlingHold()
      }
    }
    // Radix renders its scrollbar as a SIBLING of the viewport, so dragging the
    // thumb produces no event inside it at all -- delegated from the
    // scroll-area root so it survives Radix mounting the scrollbar on demand.
    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null
      if (event.target === root || target?.closest('[data-slot="scroll-area-scrollbar"]')) {
        cancelSettlingHold()
      }
    }
    const scrollArea = root.closest('[data-slot="scroll-area"]') ?? root
    root.addEventListener('scroll', onScroll, { passive: true })
    root.addEventListener('wheel', onWheel, { passive: true })
    root.addEventListener('touchmove', onTouchMove, { passive: true })
    root.addEventListener('keydown', onKeyDown, { passive: true })
    scrollArea.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('keydown', onKeyDown)
      scrollArea.removeEventListener('pointerdown', onPointerDown)
    }
  }, [viewport, endHold])

  // Content changing size under us: an image landing, a turn expanding, a
  // prepend finishing its measure. Observing the content wrapper rather than
  // an ancestor is deliberate -- the ResizeObserver loop only delivers targets
  // deeper than the previous pass, so a shallower node defers its
  // notification by a frame, and a frame here is a visibly wrong scroll
  // position.
  useLayoutEffect(() => {
    const content = rootRef.current
    if (!content) {
      return
    }
    const observer = new ResizeObserver(() => {
      applyDecision()
      const active = holdRef.current
      if (active !== null && active.settlingSince !== null) {
        armQuiescence()
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [applyDecision, armQuiescence])

  useLayoutEffect(() => {
    causeRef.current = 'session-changed'
    // biome-ignore lint/correctness/useExhaustiveDependencies(sessionKey): the session changing IS the cause being recorded, and it must be declared before the effect below that acts on causes runs on this same commit
  }, [sessionKey])

  // Every commit that changed the content -- keyed on the blocks ARRAY, not on
  // a count of it. A page landing mid-turn merges into an existing block and
  // adds neither a block nor a message, so a count would skip the very commit
  // carrying it; the rebuilt array is what actually marks that commit.
  useLayoutEffect(() => {
    applyDecision()
    // biome-ignore lint/correctness/useExhaustiveDependencies(blocks): re-run on the commit that changed the content, not because the body reads it
  }, [blocks, applyDecision])

  return { rootRef, holdAcrossLoadOlder }
}

export interface ChatConversationHandle {
  // Hold the reader's position, run the given operation, and settle the hold
  // once it lands -- ending it immediately if nothing landed above the
  // reader, so a hold with nothing to hold doesn't sit until its deadline.
  // Call this INSTEAD OF running the fetch directly: whether to fetch at all
  // is the host's decision, but once it decides to, this is what keeps the
  // reader's position steady while it does.
  holdAcrossLoadOlder(operation: () => Promise<void> | undefined): void
}

export interface ChatConversationProps {
  // Identity of the conversation. A change means "land at the end".
  sessionKey: string
  // The full, host-built block list, in order.
  blocks: readonly Block[]
  // Whether the host has any messages at all -- distinct from `blocks` being
  // empty, which also happens when the only message so far strips to nothing
  // (all system tags, no reply yet). That state renders as the ordinary
  // (visually blank) conversation view, not the empty-state text: there IS a
  // conversation, it just has nothing to show yet. Only the true absence of
  // any message shows `emptyText` -- and `hasUndelivered` dismisses it for
  // content that has not become blocks yet.
  hasMessages: boolean
  // Whether anything is waiting outside the block list -- messages that
  // arrived but have not been delivered to the agent yet, rendered in the
  // footer rather than as blocks. The empty state is dismissed by ANY
  // content, and a message waiting its turn is content: a placeholder
  // standing beside a waiting queue would say nothing has been sent.
  hasUndelivered?: boolean
  loading?: boolean
  emptyText?: string
  // True while a turn is generating -- disables editing the last user message
  // and marks the last detail item as pending.
  waiting?: boolean
  // The turn the loaded window starts inside, when only part of that turn is
  // loaded -- its own user message sits above the window, so the host hands it
  // over separately. Renders as an unstickied, non-editable header ahead of the
  // first section.
  //
  // The messages it carried, not its text: a header is the same object as the
  // block that replaces it once the rest of the turn loads, so it is described
  // the same way. Taking text here is what let a caller hand over one unparsed
  // blob and get a header that disagreed with its own replacement.
  historyHeaderParts?: readonly ChatUserMessagePart[]
  hasMoreHistory?: boolean
  loadingMoreHistory?: boolean
  onLoadOlder?: () => void
  // Present only when editing is possible at all; called with the block's own
  // `id` -- the host's identifier for it, handed straight back.
  //
  // The id and not a position, because a position is only meaningful inside
  // the array it indexes, and `blocks` is a bounded tail of the conversation:
  // a host that resolved a position against its own full history would land on
  // a different turn as soon as anything scrolled off the top. The id is the
  // host's own, so it means the same thing on both sides however much of the
  // conversation is loaded.
  //
  // The turn's text is not passed either. The host has it -- unedited by
  // whatever this component was handed for display -- and reading it there is
  // what keeps an edit working on the same bytes the host will put back.
  onEditUser?: (blockId: string) => void
  // FORK a delivered user turn into a new conversation, named by the same
  // block id. Same trust boundary as `onEditUser` — the host resolves the id
  // against its whole conversation — and the same destination rule: unset
  // means this conversation offers no fork.
  onForkUser?: (blockId: string) => void
  // Chains render expanded (full detail) by default instead of collapsed to
  // the last message.
  defaultExpanded?: boolean
  botName: string
  agentAvatar?: string
  renderers: ChatTurnRenderers
  renderTool: (item: Extract<DetailItem, { kind: 'tool' }>) => ReactNode
  // Rendered at the foot of the list, alongside the last turn -- a thinking
  // indicator, an extension-provided status visualiser, whatever the host has.
  footer?: ReactNode
}

// The scrollable conversation: turn sections built from `blocks`, a
// load-older control inside the first of them, and the scroll behaviour that
// holds the reader's place across a prepend, follows a streaming reply, and
// lands at the end on a session change.
//
// **Fully controlled and host-agnostic about data.** It takes the blocks the
// host already built and reports edits by position; it fetches nothing itself
// -- `onLoadOlder` is the host's own composed callback, built from whatever it
// needs to decide whether there is more and to call through the imperative
// handle this component exposes.
export const ChatConversation = forwardRef<ChatConversationHandle, ChatConversationProps>(function ChatConversation(
  {
    sessionKey,
    blocks,
    hasMessages,
    hasUndelivered,
    loading,
    emptyText,
    waiting,
    historyHeaderParts,
    hasMoreHistory,
    loadingMoreHistory,
    onLoadOlder,
    onEditUser,
    onForkUser,
    defaultExpanded,
    botName,
    agentAvatar,
    renderers,
    renderTool,
    footer,
  },
  ref,
) {
  const { rootRef, holdAcrossLoadOlder } = useConversationScroll(sessionKey, blocks)
  useImperativeHandle(ref, () => ({ holdAcrossLoadOlder }), [holdAcrossLoadOlder])

  const sections = useMemo(() => groupIntoTurnSections(blocks), [blocks])
  const detailsCollapsedRef = useRef(!defaultExpanded)
  const onDetailsCollapseChange = useCallback((collapsed: boolean) => {
    detailsCollapsedRef.current = collapsed
  }, [])

  // Built once here and PLACED by the section loop below, rather than rendered
  // where it is built: its position is derived from the list, so the one thing
  // that must not happen is two copies of this decision drifting apart.
  //
  // Null when the host says there is nothing left to fetch -- that absence is
  // what makes the control disappear, and `loadingMoreHistory` is what disables
  // it while a fetch is in flight. Both are unchanged by where it now sits.
  const loadOlder = hasMoreHistory ? (
    <ChatLoadOlderButton loading={loadingMoreHistory === true} onLoadOlder={onLoadOlder ?? (() => {})} />
  ) : null

  return (
    <Flex ref={rootRef} justify='end' className='min-h-full min-w-0 gap-3 px-4 py-4'>
      {loading ? (
        <div className='text-sm text-muted-foreground'>loading…</div>
      ) : !hasMessages && !hasUndelivered ? (
        <div className='flex flex-1 items-center justify-center'>
          <ChatEmptyState text={emptyText ?? 'No messages yet'} />
        </div>
      ) : (
        <>
          {/* Nothing to sit under, because there is no section at all. `blocks`
              can be empty while the conversation genuinely has messages -- a
              first question that strips to nothing but system tags -- and that
              is exactly the case where dropping the control would strand the
              reader with no way back into history. So it renders on its own
              here, which is also where it always used to render. */}
          {sections.length === 0 && loadOlder}
          {sections.map((section, sectionIndex) => {
            // One section per turn: the user message sticks to the top of the
            // viewport while its own replies scroll under it, and the next
            // turn's section pushes it out on the way past. Bounding each
            // header to its section is what produces that hand-off, so no
            // scroll position is read anywhere.
            //
            // The question is hoisted so the edit/fork closures hold a
            // narrowed local: a property chain does not carry its narrowing
            // into a callback, which is what made the edit closure assert
            // non-null to say what this local already knows.
            const user = section.user
            return (
            <Flex key={section.id} className='w-full min-w-0 gap-3'>
              {user ? (
                <ChatUserMessage
                  sticky
                  renderers={renderers}
                  blockId={user.id}
                  parts={user.parts}
                  // Editing waits for the turn; forking does not, and it is
                  // not an oversight that no `forkDisabled` is passed here.
                  // A fork copies the conversation up to THIS message, which
                  // finished long ago — the turn running now sits after the
                  // cut. Branching mid-run is also when a reader most wants
                  // to: watching one attempt go wrong is the reason to start
                  // the other from the same point.
                  editDisabled={waiting}
                  onEdit={onEditUser ? () => onEditUser(user.id) : undefined}
                  onFork={onForkUser ? () => onForkUser(user.id) : undefined}
                />
              ) : (
                // Only the first section can lack a question: the window starts
                // inside a turn whose own `user` event is above it. Not
                // editable -- the message it refers to isn't loaded.
                //
                // It arrives as the messages it was built from, exactly as the
                // block that will replace it does. This used to take one text
                // instead, on the reasoning that the host had the words but not
                // the delivery they were decoded out of -- which was not true:
                // the host holds the whole delivered prompt and was simply
                // discarding its structure on the way here. A turn carrying
                // several messages therefore read as one, with its authors and
                // send times missing, until the rest of it loaded.
                sectionIndex === 0 &&
                historyHeaderParts != null &&
                historyHeaderParts.length > 0 && (
                  <ChatUserMessage sticky renderers={renderers} blockId='u:header' parts={historyHeaderParts} />
                )
              )}
              {/* The control belongs to whatever is CURRENTLY the first section,
                  under whatever leads it: a real question, or the synthesized
                  header standing in for one that sits above the window. After a
                  prepend the first section is a different turn, so the button
                  moves with it -- which is why its place is derived from
                  `sectionIndex` on every render instead of being rendered once
                  beside the list. Getting that wrong strands it mid-transcript
                  after a single click.

                  A first section with neither a question nor a header is
                  reachable (the header text and its index are separately
                  optional), and needs no special case: with nothing rendered
                  above it, this falls to the top of the section on its own.

                  It passes BEHIND the leading message rather than over it. This
                  is a plain static box, so it paints at its parent's level,
                  while the message above is `sticky z-1`. Nothing here may take
                  a z-index or open a stacking context: the header's `z-1` is
                  exact (see chat-turn for why neither bound has slack), and a
                  positioned box with an automatic z-index sits at 0 and loses to
                  it on tree order -- which is precisely what keeps this
                  underneath. */}
              {sectionIndex === 0 && loadOlder}
              {section.items.map((b) =>
                b.kind === 'user' ? null : (
                  <ChatTurnDetails
                    key={b.id}
                    renderers={renderers}
                    renderTool={renderTool}
                    blockId={b.id}
                    items={b.items}
                    botName={botName}
                    agentAvatar={agentAvatar}
                    defaultCollapsed={detailsCollapsedRef.current}
                    onCollapseChange={onDetailsCollapseChange}
                    pending={b.absoluteIndex === blocks.length - 1 && waiting === true}
                  />
                ),
              )}
            </Flex>
            )
          })}
        </>
      )}
      {footer}
    </Flex>
  )
})
