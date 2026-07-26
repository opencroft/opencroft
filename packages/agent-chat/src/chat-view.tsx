'use client'

import type { ChatBlock, ChatMessage } from 'agent-client/fold'
import { Bot, Copy, GitFork } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { StickySection } from 'ui/components/experimental/sticky-section'
import { useAutoScroll } from 'ui/components/hooks/use-auto-scroll'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from 'ui/components/ui/context-menu'
import { Flex } from 'ui/components/ui/layout/flex'
import { ScrollArea } from 'ui/components/ui/layout/scroll-area'
import { ScrollToBottomButton } from 'ui/components/ui/utils/scroll-to-bottom-button'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { cn } from 'ui/lib/utils'

import { ThinkingIndicator } from './thinking-indicator'
import { hasToolView, type ToolViewRegistry } from './tool-views'
import { TurnDetails } from './turn-details'
import { groupIntoTurnSections } from './turn-sections'

// Select-and-execCommand fallback for insecure contexts (plain http, e.g. served
// over a LAN IP) where the async Clipboard API is unavailable. Uses a Selection
// + Range rather than focusing a textarea, so it isn't defeated by the focus trap
// of the surrounding context menu (which would otherwise copy nothing).
function legacyCopy(text: string): boolean {
  const span = document.createElement('span')
  span.textContent = text
  span.style.cssText = 'position:fixed;top:0;left:0;opacity:0;white-space:pre;user-select:text'
  document.body.appendChild(span)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(span)
  selection?.removeAllRanges()
  selection?.addRange(range)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    selection?.removeAllRanges()
    document.body.removeChild(span)
  }
  return ok
}

// Copy text to the clipboard. Prefers the async Clipboard API (secure contexts:
// https / localhost) and falls back to the legacy path otherwise.
async function copyText(text: string): Promise<void> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else if (!legacyCopy(text)) {
      throw new Error('Clipboard copy is not supported here.')
    }
    toast.success('Copied')
  } catch (error) {
    // Last-ditch legacy attempt if the async API rejected (e.g. lost focus).
    if (legacyCopy(text)) {
      toast.success('Copied')
      return
    }
    toast.error('Copy failed', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface ChatViewProps {
  // Folded conversation, as produced by `buildBlocks(foldEvents(events))`
  // (or the `blocks` returned from `useAgentSession`).
  blocks: ChatBlock[]
  // Custom views for specific tools, keyed by tool name. Defaults to none.
  toolViews?: ToolViewRegistry
  // Hide the agent's reasoning ("thinking") messages.
  hideThinking?: boolean
  // Hide tool calls. Tools with a rendering custom view stay visible, and
  // *unresolved* permission prompts always stay visible so they can be answered
  // (unless the session bypasses permissions, in which case none are emitted).
  hideToolCalls?: boolean
  // Show the typing indicator at the end while a turn is running.
  turnActive?: boolean
  // Offer "Fork from here" on user turns (only the native harness supports it).
  canFork?: boolean
  onFork?: (turnIndex: number, text: string) => void
  onRespondPermission: (requestId: string, optionId?: string) => void
  onRespondAsk: (requestId: string, answer?: string) => void
  // Deny the pending tool and tell the agent what to do differently.
  onRespondText?: (requestId: string, text: string) => void
  // Shown beside the first item of each turn, and next to the avatar (if any).
  botName?: string
  agentAvatar?: string
  // Whether a turn's details start expanded the first time it's rendered.
  // Toggling any turn's collapse state becomes the default for the next turn
  // that arrives, so this only governs the very first one. Defaults to true.
  defaultExpanded?: boolean
  // Changes when the host switches to a different conversation (e.g. its
  // session id) — resets the render window (see below) so a previous chat's
  // grown/shrunk window doesn't briefly apply to the new one. Omit if the
  // host only ever mounts one conversation per <ChatView> instance.
  resetKey?: string
  // Shown when there are no visible messages.
  emptyState?: ReactNode
  // Host UI slot: extra content rendered at the foot of the message list,
  // beside the typing indicator (below the last block, still inside the
  // scrolling area) — e.g. a voice/status visualizer.
  transcriptFooter?: ReactNode
  // Sticky composer pinned to the bottom of the scroll viewport.
  footer?: ReactNode
  className?: string
}

function isItemVisible(
  message: ChatMessage,
  hideThinking: boolean,
  hideToolCalls: boolean,
  toolViews: ToolViewRegistry,
): boolean {
  if (message.kind === 'thought') return !hideThinking
  if (message.kind === 'tool') return !hideToolCalls || hasToolView(message, toolViews)
  // Pending permissions must stay actionable even with tools hidden.
  if (message.kind === 'permission') return !hideToolCalls || !message.resolved
  return true
}

// Render window over the filtered blocks: only the last `visibleCount` are
// mounted, so a long history doesn't pay for rendering every block just to
// open at the end (react-markdown, tool views, chain layout — all of it).
// Scrolling the sentinel above the window into view grows it. The window's
// anchoring depends on scroll pin state: pinned at the bottom it slides with
// the conversation and shrinks back to the initial size as new blocks arrive
// (recycling old DOM); un-pinned (reading history) its start is frozen —
// appends grow it below — so content already on screen never shifts under
// the reader.
const INITIAL_VISIBLE_BLOCKS = 30
const LOAD_MORE_STEP = 30

export function ChatView({
  blocks,
  toolViews = {},
  hideThinking = false,
  hideToolCalls = false,
  turnActive = false,
  canFork = false,
  onFork,
  onRespondPermission,
  onRespondAsk,
  onRespondText,
  botName,
  agentAvatar,
  defaultExpanded = true,
  resetKey,
  emptyState,
  transcriptFooter,
  footer,
  className,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Seeds each newly-rendered turn's initial collapsed state with the last
  // choice the user made — a ref (not state) because changing it must not
  // itself trigger a re-render; it only matters the next time a turn mounts.
  const collapsedDefaultRef = useRef(!defaultExpanded)
  const onDetailsCollapseChange = useCallback((collapsed: boolean) => {
    collapsedDefaultRef.current = collapsed
  }, [])

  // Apply the thinking/tools visibility toggles, dropping chains left empty.
  const filteredBlocks = useMemo(
    () =>
      blocks
        .map((block) =>
          block.kind === 'user'
            ? block
            : {
                ...block,
                items: block.items.filter((message) => isItemVisible(message, hideThinking, hideToolCalls, toolViews)),
              },
        )
        .filter((block) => block.kind === 'user' || block.items.length > 0),
    [blocks, hideThinking, hideToolCalls, toolViews],
  )

  // Start at the bottom, and auto-scroll on new content only while the user is
  // already at the bottom (so scrolling up to read isn't yanked back down).
  const { handleScroll, isAtBottom } = useAutoScroll(scrollRef, filteredBlocks)

  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_BLOCKS)
  // A new conversation's window starts fresh — otherwise a previous chat's
  // grown (or shrunk) count would carry over and render the wrong slice for a
  // beat before the effects below catch up.
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_BLOCKS)
  }, [resetKey])

  const startIndex = Math.max(0, filteredBlocks.length - visibleCount)
  const hasOlder = startIndex > 0
  const visibleBlocks = filteredBlocks.slice(startIndex)

  // Set by loadOlder() just before growing the window; consumed by the layout
  // effect below once the older blocks have actually been added to the DOM.
  const pendingScrollRestoreRef = useRef<number | null>(null)

  const loadOlder = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      // Record how far the bottom of the viewport is from the current scroll
      // position — after older blocks are prepended above it, restoring to the
      // same distance from the (now taller) scrollHeight keeps the reader's
      // place instead of jumping them to the top of the newly loaded chunk.
      pendingScrollRestoreRef.current = el.scrollHeight - el.scrollTop
    }
    // No cap at filteredBlocks.length: startIndex already clamps at 0, an
    // oversized count renders the same slice, and once everything is visible
    // the sentinel unmounts so growth stops.
    setVisibleCount((prev) => prev + LOAD_MORE_STEP)
  }, [])

  useLayoutEffect(() => {
    const delta = pendingScrollRestoreRef.current
    if (delta === null) return
    pendingScrollRestoreRef.current = null
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight - delta
  }, [visibleCount])

  const sentinelRef = useRef<HTMLDivElement>(null)
  // Whether the sentinel is currently in view, per the observer below. Read by
  // the recycle effect: while the sentinel is visible, shrinking would put it
  // right back in view and re-trigger loadOlder — an infinite grow/shrink loop
  // whenever the whole window fits inside the viewport (short collapsed
  // blocks, tall panel: nothing scrollable, so "at bottom" AND
  // sentinel-visible hold at once). Blocking the shrink instead lets an
  // under-filled window grow until it fills the viewport and then rest there.
  const sentinelVisibleRef = useRef(false)
  useEffect(() => {
    if (!hasOlder) return
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries[0]?.isIntersecting ?? false
        if (sentinelVisibleRef.current) loadOlder()
      },
      { root },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      // An unmounted (or about-to-be-reobserved) sentinel is not in view; a
      // stale true here would block recycling indefinitely.
      sentinelVisibleRef.current = false
    }
  }, [hasOlder, loadOlder])

  // React to the conversation growing. At-bottom: shrink a grown window back
  // so old blocks unmount, same as if the chat had just been opened (guarded
  // on the sentinel being out of view, see sentinelVisibleRef). Scrolled up:
  // freeze startIndex by widening the window by exactly the number of
  // appended blocks — otherwise the end-anchored slice would drop the top
  // visible block on every append and yank the content the reader is on.
  const prevBlockCountRef = useRef(filteredBlocks.length)
  useEffect(() => {
    const appended = filteredBlocks.length - prevBlockCountRef.current
    prevBlockCountRef.current = filteredBlocks.length
    if (isAtBottom()) {
      if (!sentinelVisibleRef.current) {
        setVisibleCount((prev) => Math.min(prev, INITIAL_VISIBLE_BLOCKS))
      }
    } else if (appended > 0) {
      setVisibleCount((prev) => prev + appended)
    }
  }, [filteredBlocks.length, isAtBottom])

  // 0-based turn index per user block, so "fork from here" rewinds to that
  // turn — computed over the full filtered list, not the render window, so
  // indices stay correct regardless of how much is actually mounted.
  const turnIndexById = new Map<string, number>()
  let userTurn = -1
  for (const block of filteredBlocks) {
    if (block.kind === 'user') {
      userTurn += 1
      turnIndexById.set(block.id, userTurn)
    }
  }

  // The last block while a turn is running is the active one — TurnDetails
  // applies `pending` to its own last item (e.g. a streaming thought's spinner).
  const lastBlock = filteredBlocks[filteredBlocks.length - 1]

  const sections = useMemo(() => groupIntoTurnSections(visibleBlocks), [visibleBlocks])

  return (
    <Flex expanded className={className ?? 'min-h-0 justify-end'}>
      <ScrollArea ref={scrollRef} className='w-full' innerClassName='items-center' onScroll={handleScroll}>
        {visibleBlocks.length === 0 ? (
          <Flex align='center' justify='center' className='min-h-40 p-8 text-sm text-muted-foreground gap-2'>
            {emptyState ?? (
              <>
                <Bot className='size-8 opacity-40' />
                No messages yet.
              </>
            )}
          </Flex>
        ) : (
          <Flex withGaps className='w-full max-w-2xl gap-4 px-4 py-4'>
            {hasOlder && (
              <div ref={sentinelRef} className='py-1 text-center text-xs text-muted-foreground'>
                · · ·
              </div>
            )}
            {sections.map((section) => (
              // One section per turn: the user message sticks to the top of the
              // viewport while its own replies scroll under it, and the next
              // turn's section pushes it out on the way past. Bounding each
              // header to its section is what produces that hand-off, so no
              // scroll position is read anywhere.
              <Flex withGaps key={section.id} className='w-full gap-4'>
                {section.user && (
                  <UserBubble
                    sticky
                    text={section.user.text}
                    canFork={canFork}
                    forkDisabled={turnActive}
                    onFork={
                      onFork ? () => onFork(turnIndexById.get(section.id) ?? 0, section.user?.text ?? '') : undefined
                    }
                  />
                )}
                {section.items.map((block) =>
                  block.kind === 'chain' ? (
                    <TurnDetails
                      key={block.id}
                      items={block.items}
                      toolViews={toolViews}
                      hideToolCalls={hideToolCalls}
                      botName={botName}
                      agentAvatar={agentAvatar}
                      defaultCollapsed={collapsedDefaultRef.current}
                      onCollapseChange={onDetailsCollapseChange}
                      pending={block === lastBlock && turnActive}
                      onRespondPermission={onRespondPermission}
                      onRespondAsk={onRespondAsk}
                      onRespondText={onRespondText}
                    />
                  ) : null,
                )}
              </Flex>
            ))}
            {turnActive && <ThinkingIndicator />}
            {transcriptFooter}
          </Flex>
        )}

        {footer && (
          <StickySection side='bottom' fade variant='background' className='w-full max-w-2xl'>
            <Flex className='absolute right-0 top-0'>
              <ScrollToBottomButton scrollContainerRef={scrollRef} />
            </Flex>
            <div className='flex-1'>{footer}</div>
          </StickySection>
        )}
      </ScrollArea>
    </Flex>
  )
}

function UserBubble({
  text,
  canFork,
  forkDisabled,
  onFork,
  sticky,
}: {
  text: string
  canFork?: boolean
  forkDisabled?: boolean
  onFork?: () => void
  // Hold the top of the viewport while this turn's replies scroll underneath.
  // Needs an opaque background, since content passes behind it, and a z-index
  // above the replies it covers.
  sticky?: boolean
}) {
  const isMobile = useIsMobile()
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Touch screens have no right-click. On mobile, suppress the native long-press
  // context menu (a trusted `contextmenu` event) and instead open the menu on a
  // plain tap by dispatching a synthetic (untrusted) `contextmenu` event.
  useEffect(() => {
    if (!isMobile) return
    const el = wrapperRef.current
    if (!el) return
    // Capture phase fires before Radix's trigger listener.
    const suppress = (event: Event) => {
      if (event.isTrusted) {
        event.stopPropagation()
        event.preventDefault()
      }
    }
    el.addEventListener('contextmenu', suppress, { capture: true })
    return () => el.removeEventListener('contextmenu', suppress, { capture: true })
  }, [isMobile])

  const handleTap = (event: React.MouseEvent<HTMLElement>) => {
    // Don't hijack taps that were clearing a text selection.
    if (document.getSelection()?.toString()) {
      document.getSelection()?.removeAllRanges()
      return
    }
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: event.clientX, clientY: event.clientY }),
    )
  }

  return (
    <div
      ref={wrapperRef}
      // The bubble's own tint is translucent, so when stuck it gets an opaque
      // layer beneath it — otherwise the replies passing underneath show
      // through the header. The background sits on the padded box, so the
      // breathing room below is covered too rather than being a gap replies
      // scroll through.
      //
      // `z-1` is exact, not a round number, and both bounds are load-bearing:
      // it must exceed the replies, which each wrap their entries in a
      // `relative` box that sits at 0 and comes later in the document; and it
      // must not exceed the composer, which is also `z-1` and later still, so
      // tree order keeps the composer on top. No integer sits between those,
      // which is why the header matches the composer rather than clearing it.
      //
      // `pt-2 -mt-2` buys that breathing room only while stuck. The two cancel
      // in normal flow — the box's top edge moves up by the same amount its
      // content moves down, so the element's vertical footprint, and every
      // position below it, is unchanged. Stuck, the top edge is pinned to the
      // viewport instead, so the padding becomes visible space above the
      // message. There is no `:stuck` selector to do this more directly.
      className={cn('self-end max-w-[85%]', sticky && 'sticky top-0 z-1 rounded-lg bg-background pt-2 -mt-2')}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild onClick={isMobile ? handleTap : undefined}>
          <div className='rounded-lg bg-primary/10 px-3 py-2 prose-chat'>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void copyText(text)}>
            <Copy /> Copy
          </ContextMenuItem>
          {canFork && onFork && (
            <ContextMenuItem disabled={forkDisabled} onClick={onFork}>
              <GitFork /> Fork from here
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
