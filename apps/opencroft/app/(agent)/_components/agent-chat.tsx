'use client'

import { ChainDot, Chained } from 'agent-chat/chain'
import { ThinkingBlock } from 'agent-chat/thinking-block'
import { groupIntoTurnSections } from 'agent-chat/turn-sections'
import {
  type ComponentType,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from 'ui/button'
import { TypingDots } from 'ui/chat/typing-dots'
import { Flex } from 'ui/layout/flex'
import {
  BLOCK_ID_ATTR,
  type ChatTurnRenderers,
  ChatLoadOlderButton,
  ChatTurnDetails,
  ChatUserMessage,
  type DetailItem as KitDetailItem,
} from 'ui/agent-chat/chat-turn'

import { type Block, buildBlocks, type DetailItem, type UserText } from '@/app/(agent)/_lib/build-blocks'
import type { ChatMessage } from '@/app/(agent)/_lib/messages'
import { AT_TOP_THRESHOLD, decideScrollAction, isAtBottom, type ScrollCause } from '@/app/(agent)/_lib/scroll-intent'
import { contentTop, HOLD_DEADLINE_MS, type HoldState, holdExpired, holdStep } from '@/app/(agent)/_lib/scroll-restore'
import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/(extension-runtime)/_client/provides'
import { GenericToolView } from '@/components/tool-views/builtin-views'
import { lookupToolView } from '@/components/tool-views/registry'
import { cn } from '@/lib/utils'

// The rail and the thinking block the installed turn components render with.
// They stay the package's copies deliberately: `ui` sits below `agent-chat`, so
// the kit component cannot import them, and both exist in two implementations
// today — supplying them here is what keeps one conversation from mixing the
// two. Module-level so the reference is stable across renders.
const CHAT_RENDERERS: ChatTurnRenderers = { Chained, ChainDot, ThinkingBlock }

// A registered tool view (see components/tool-views) renders in place of the
// generic block, giving e.g. remote_edit/edit_node_property a real diff instead
// of a raw args dump. Falls back to the same chrome without a target line
// otherwise (e.g. an external MCP server's tool, with no node/handle to point
// at). Which views exist is this application's registry, so it is passed in
// rather than known by the component.
function renderToolCall(item: Extract<KitDetailItem, { kind: 'tool' }>) {
  const spec = lookupToolView(item.name)
  const args = (item.args ?? {}) as Record<string, unknown>
  if (spec) {
    const ViewComponent = spec.body
    return <ViewComponent tool={item.name} args={args} requestId={item.id} mode='history' result={item.result} />
  }
  return <GenericToolView tool={item.name} args={args} result={item.result} />
}

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
  //
  // The two are separately optional on purpose: a question made entirely of
  // system tags has no words to show as a header, but the turn it names is
  // still the one the leading block belongs to, so the index outlives the text.
  historyHeader?: { index: number; text: UserText | null } | null
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

// Keys that move a scroll container rather than a caret. Space is included
// because it pages a scroller when focus isn't in a text field.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

// A position being held across a prepend while the content above settles.
interface ActiveHold {
  state: HoldState
  // When corrections started, or null while the fetched page has yet to land.
  // The deadline and the quiescence check both run from this rather than from
  // the capture, so a slow request doesn't spend the budget that exists to
  // bound how long the content takes to settle.
  settlingSince: number | null
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
  // Fetch the previous page. Driven by a click and nothing else — there is no
  // question of when to fire, which is the whole point of the change.
  //
  // No re-entrancy lock: the button is absent when there is nothing left and
  // disabled while a fetch is in flight, and `loadMoreHistory` is itself a
  // no-op while one is running. That is the same guarantee the lock provided,
  // made structurally rather than defended.
  const loadOlder = useCallback(() => {
    const current = sessionRef.current
    if (current.hasMoreHistory !== true || current.loadingMoreHistory === true) {
      return
    }
    beginHold()
    void Promise.resolve(current.loadMoreHistory?.()).finally(() => {
      // Two frames: one for React to commit the page, one to see whether that
      // commit put anything above the reader. If it didn't, the hold has
      // nothing to hold and would otherwise sit there until its deadline.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (holdRef.current?.settlingSince === null) {
            endHold()
          }
        })
      })
    })
  }, [beginHold, endHold])

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
    // The only thing scrolling still decides: whether the reader is following
    // the end of the conversation. Loading history no longer reacts to it.
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
    // content coordinates — so the reader's own scrolling is preserved by
    // construction rather than needing the hold dropped. Cancelling there
    // instead would abandon the correction for the most ordinary interaction
    // there is: scrolling up continuously through history.
    const cancelSettlingHold = () => {
      const active = holdRef.current
      if (active !== null && active.settlingSince !== null) {
        endHold()
      }
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        // Reading upward stops the bottom-follow immediately, so streaming
        // content can't yank the view back down.
        atBottomRef.current = false
      }
      cancelSettlingHold()
    }
    const onTouchMove = () => cancelSettlingHold()
    // Filtered rather than "any keydown": these keys move the view, while a
    // keystroke inside a message (an inline edit) moves a caret. Keyboard
    // scrolling reaches this listener because it requires focus to be inside
    // the viewport in the first place — either on a child, or on the scroller
    // itself where the engine makes it focusable.
    // `globalThis.` because React's KeyboardEvent is imported into this file for
    // JSX handlers and shadows the DOM one; this is a real listener, not a JSX
    // prop, so it needs the DOM type.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) {
        cancelSettlingHold()
      }
    }
    // Radix renders its scrollbar as a SIBLING of the viewport, so dragging the
    // thumb produces no event inside it at all — the one genuine user scroll
    // that neither wheel, touch nor key covers. Delegated from the scroll-area
    // root so it survives Radix mounting the scrollbar on demand, and narrowed
    // to the scrollbar (or the scroller itself, where a native bar would be
    // pressed) so that clicking a button in a message is not a scroll.
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
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [applyDecision, armQuiescence])

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
  }, [blocks, applyDecision])

  return { rootRef, loadOlder }
}

// Everything the session holds is mounted: the server window is the only one.
// A second window in blocks used to sit on top of it, and because its unit
// (folded blocks) didn't match the server's (events), the two could disagree
// about whether anything was left — which is how a scroll-up could load
// nothing at all. At 5 records a page the DOM grows only as fast as someone
// scrolls, so bounding it bought nothing that the mismatch didn't cost more.
// Stamped on each rendered block's root so the scroll restore can find a
// specific block in the DOM again after a prepend has shifted it.
// Where a block sits in the scrollable content, or null if it isn't in the DOM.
// This is the coordinate the reader scrolling does not change, so only content
// actually inserted above the block moves the number — which is what makes a
// prepend measurable independently of everything else on screen.
function blockContentTop(root: HTMLElement, id: string): number | null {
  const el = root.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`)
  return el ? contentTop(el.getBoundingClientRect().top, root.getBoundingClientRect().top, root.scrollTop) : null
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
  const { rootRef, loadOlder } = useChatScroll({
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
          {hasOlder && <ChatLoadOlderButton loading={session.loadingMoreHistory === true} onLoadOlder={loadOlder} />}
          {sections.map((section, sectionIndex) => (
            // One section per turn: the user message sticks to the top of the
            // viewport while its own replies scroll under it, and the next
            // turn's section pushes it out on the way past. Bounding each
            // header to its section is what produces that hand-off, so no
            // scroll position is read anywhere.
            <Flex key={section.id} className='w-full min-w-0 gap-3'>
              {section.user ? (
                <ChatUserMessage
                  sticky
                  renderers={CHAT_RENDERERS}
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
                session.historyHeader?.text != null && (
                  <ChatUserMessage sticky renderers={CHAT_RENDERERS} blockId='u:header' text={session.historyHeader.text} />
                )
              )}
              {section.items.map((b) =>
                b.kind === 'user' ? null : (
                  <ChatTurnDetails
                    key={b.id}
                    renderers={CHAT_RENDERERS}
                    renderTool={renderToolCall}
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

export function AgentChatInputControls(props: AgentVoiceControlProps) {
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
