'use client'

import type { ChatBlock, ChatMessage } from 'agent-client/fold'
import { Bot, Copy, GitFork } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { StickySection } from 'ui/components/experimental/sticky-section'
import { useAutoScroll } from 'ui/components/hooks/use-auto-scroll'
import { TypingDots } from 'ui/components/ui/chat/typing-dots'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from 'ui/components/ui/context-menu'
import { Flex } from 'ui/components/ui/layout/flex'
import { ScrollArea } from 'ui/components/ui/layout/scroll-area'
import { ScrollToBottomButton } from 'ui/components/ui/utils/scroll-to-bottom-button'
import { useIsMobile } from 'ui/hooks/use-mobile'

import { MessageView } from './messages'
import { hasToolView, type ToolViewRegistry } from './tool-views'

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
  onFork?: (turnIndex: number) => void
  onRespondPermission: (requestId: string, optionId?: string) => void
  onRespondAsk: (requestId: string, answer?: string) => void
  // Deny the pending tool and tell the agent what to do differently.
  onRespondText?: (requestId: string, text: string) => void
  // Shown when there are no visible messages.
  emptyState?: ReactNode
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
  emptyState,
  footer,
  className,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Apply the thinking/tools visibility toggles, dropping chains left empty.
  const visibleBlocks = useMemo(
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
  const { handleScroll } = useAutoScroll(scrollRef, visibleBlocks)

  // 0-based turn index per user block, so "fork from here" rewinds to that turn.
  const turnIndexById = new Map<string, number>()
  let userTurn = -1
  for (const block of visibleBlocks) {
    if (block.kind === 'user') {
      userTurn += 1
      turnIndexById.set(block.id, userTurn)
    }
  }

  // The last item while a turn is running — marked pending so a streaming
  // thought shows its spinner.
  const lastBlock = visibleBlocks[visibleBlocks.length - 1]
  const activeItemId =
    turnActive && lastBlock && lastBlock.kind !== 'user' ? lastBlock.items[lastBlock.items.length - 1]?.id : undefined

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
            {visibleBlocks.map((block) =>
              block.kind === 'user' ? (
                <UserBubble
                  key={block.id}
                  text={block.text}
                  canFork={canFork}
                  forkDisabled={turnActive}
                  onFork={onFork ? () => onFork(turnIndexById.get(block.id) ?? 0) : undefined}
                />
              ) : (
                <Flex key={block.id} withGaps className='gap-2'>
                  {block.items.map((message) => (
                    <MessageView
                      key={message.id}
                      message={message}
                      toolViews={toolViews}
                      hideToolCalls={hideToolCalls}
                      pending={message.id === activeItemId}
                      onRespondPermission={onRespondPermission}
                      onRespondAsk={onRespondAsk}
                      onRespondText={onRespondText}
                    />
                  ))}
                </Flex>
              ),
            )}
            {turnActive && (
              <Flex row align='center' className='gap-2 text-sm text-muted-foreground'>
                <TypingDots variant='primary' size='sm' /> Typing…
              </Flex>
            )}
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
}: {
  text: string
  canFork?: boolean
  forkDisabled?: boolean
  onFork?: () => void
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
    <div ref={wrapperRef} className='self-end max-w-[85%]'>
      <ContextMenu>
        <ContextMenuTrigger asChild onClick={isMobile ? handleTap : undefined}>
          <div className='rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word'>{text}</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(text)}>
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
