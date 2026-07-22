'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ChainDot, type ChainDotVariant, Chained } from 'agent-chat/chain'
import { ConfigOptionsBar } from 'agent-chat/config-options-bar'
import { ThinkingBlock } from 'agent-chat/thinking-block'
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

import type { ChatMessage } from '@/app/(agent)/_lib/messages'
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

const SCROLL_BOTTOM_THRESHOLD = 32

function useStickToBottom(resetKey: string, contentKey: number) {
  const rootRef = useRef<HTMLDivElement>(null)
  // Whether the view is "pinned" to the bottom and should follow new content.
  const pinned = useRef(true)
  // Set while we scroll ourselves, so our own scroll events aren't mistaken for
  // the user moving away from the bottom (which would unpin and stop following).
  const programmatic = useRef(false)

  const viewport = useCallback(
    () => rootRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null,
    [],
  )

  // Marks a scrollTop mutation as "ours" for two animation frames so the scroll
  // listener below doesn't read it as the user scrolling — shared by the
  // bottom-follow logic here and by the windowed-history scroll-position
  // restore in AgentChat (which also mutates scrollTop programmatically).
  const runProgrammatic = useCallback((mutate: () => void) => {
    programmatic.current = true
    mutate()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmatic.current = false
      })
    })
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = viewport()
    if (!el) {
      return
    }
    runProgrammatic(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [viewport, runProgrammatic])

  useEffect(() => {
    const el = viewport()
    if (!rootRef.current || !el) {
      return
    }
    const onScroll = () => {
      if (programmatic.current) {
        return
      }
      pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_BOTTOM_THRESHOLD
    }
    // A wheel gesture toward the top unpins immediately, so streaming content
    // can't yank the view back down while the user is reading up.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pinned.current = false
      }
    }
    el.addEventListener('scroll', onScroll)
    el.addEventListener('wheel', onWheel, { passive: true })
    const observer = new ResizeObserver(() => {
      if (pinned.current) {
        scrollToBottom()
      }
    })
    observer.observe(rootRef.current)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [viewport, scrollToBottom])

  // Follow new content while pinned (covers updates that don't change height).
  // biome-ignore lint/correctness/useExhaustiveDependencies(contentKey): re-run when the message count changes
  useEffect(() => {
    if (pinned.current) {
      scrollToBottom()
    }
  }, [contentKey, scrollToBottom])

  // Re-pin and jump to the bottom when switching to another session.
  // biome-ignore lint/correctness/useExhaustiveDependencies(resetKey): re-pin the scroll to the bottom when the session changes
  useLayoutEffect(() => {
    pinned.current = true
    scrollToBottom()
  }, [resetKey, scrollToBottom])

  return {
    rootRef,
    viewport,
    runProgrammatic,
    // Read, not subscribed to — callers poll this at the moment they need it
    // (e.g. deciding whether to shrink the render window) rather than
    // re-rendering on every pin/unpin.
    isPinned: useCallback(() => pinned.current, []),
  }
}

// Render window over `blocks`: only the last `visibleCount` are mounted, so a
// long history doesn't pay for thousands of ReactMarkdown/tool-view renders
// (and the ResizeObserver-driven scroll-to-bottom in useStickToBottom doesn't
// visually scroll through all of them) just to open at the end. Scrolling the
// sentinel above the window into view grows it. The window's anchoring depends
// on pin state: pinned at the bottom it slides with the conversation and
// shrinks back to the initial size as new blocks arrive (recycling old DOM);
// un-pinned (reading history) its start is frozen — appends grow it below —
// so content never shifts under the reader.
const INITIAL_VISIBLE_BLOCKS = 30
const LOAD_MORE_STEP = 30

export function AgentChat({ session, emptyText, agentAvatar, agentName, defaultExpanded }: AgentChatProps) {
  const displayName = agentName ?? session.botName
  // Computed over the FULL message list, not the visible window: turn indices
  // (for edit/fork) must stay correct regardless of how much is rendered, and
  // folding/building is cheap next to the cost of actually rendering blocks.
  const blocks = useMemo(() => buildBlocks(session.messages), [session.messages])
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
  const { rootRef, viewport, runProgrammatic, isPinned } = useStickToBottom(session.sessionKey, blocks.length)
  const detailsCollapsedRef = useRef(!defaultExpanded)
  const onDetailsCollapseChange = useCallback((collapsed: boolean) => {
    detailsCollapsedRef.current = collapsed
  }, [])

  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_BLOCKS)
  // A new session's window starts fresh — otherwise a previous chat's grown
  // (or shrunk) count would carry over and render the wrong slice for a beat.
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_BLOCKS)
  }, [session.sessionKey])

  const startIndex = Math.max(0, blocks.length - visibleCount)
  const hasOlder = startIndex > 0
  const visibleBlocks = blocks.slice(startIndex)

  // Set by loadOlder() just before growing the window; consumed by the layout
  // effect below once the older blocks have actually been added to the DOM.
  // Left null for any other visibleCount change (e.g. the pinned-shrink path),
  // which is how that path avoids fighting over scrollTop with this one.
  const pendingScrollRestoreRef = useRef<number | null>(null)

  const loadOlder = useCallback(() => {
    const el = viewport()
    if (el) {
      // Record how far the bottom of the viewport is from the current scroll
      // position — after older blocks are prepended above it, restoring to the
      // same distance from the (now taller) scrollHeight keeps the reader's
      // place instead of jumping them to the top of the newly loaded chunk.
      pendingScrollRestoreRef.current = el.scrollHeight - el.scrollTop
    }
    // No cap at blocks.length: startIndex already clamps at 0, an oversized
    // count renders the same slice, and once everything is visible the sentinel
    // unmounts so growth stops. Capping would put blocks.length in this
    // callback's deps and rebuild the IntersectionObserver on every appended
    // block for nothing.
    setVisibleCount((prev) => prev + LOAD_MORE_STEP)
  }, [viewport])

  useLayoutEffect(() => {
    const delta = pendingScrollRestoreRef.current
    if (delta === null) {
      return
    }
    pendingScrollRestoreRef.current = null
    const el = viewport()
    if (!el) {
      return
    }
    // Programmatic: without this guard, moving scrollTop away from the top
    // would read as the user scrolling and could unpin them from the bottom.
    runProgrammatic(() => {
      el.scrollTop = el.scrollHeight - delta
    })
  }, [visibleCount, viewport, runProgrammatic])

  const sentinelRef = useRef<HTMLDivElement>(null)
  // Whether the sentinel is currently in view, per the observer below. Read by
  // the recycle effect: while the sentinel is visible, shrinking would put it
  // right back in view and re-trigger loadOlder — an infinite grow/shrink loop
  // whenever the whole window fits inside the viewport (short collapsed blocks,
  // tall panel: nothing scrollable, so pinned AND sentinel-visible hold at
  // once). Blocking the shrink instead lets an under-filled window grow until
  // it fills the viewport and then rest there.
  const sentinelVisibleRef = useRef(false)
  useEffect(() => {
    if (!hasOlder) {
      return
    }
    const el = sentinelRef.current
    const root = viewport()
    if (!el || !root) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries[0]?.isIntersecting ?? false
        if (sentinelVisibleRef.current) {
          loadOlder()
        }
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
  }, [hasOlder, viewport, loadOlder])

  // React to the conversation growing, per the window-anchoring rules above.
  // Pinned: shrink a grown window back so old blocks unmount, same as if the
  // chat had just been opened (guarded on the sentinel being out of view, see
  // sentinelVisibleRef). Un-pinned: freeze startIndex by widening the window by
  // exactly the number of appended blocks — otherwise the end-anchored slice
  // would drop the top visible block on every append and yank the content the
  // reader is on. The frozen window is recycled later, once the user re-pins
  // and the next block arrives.
  const prevBlockCountRef = useRef(blocks.length)
  useEffect(() => {
    const appended = blocks.length - prevBlockCountRef.current
    prevBlockCountRef.current = blocks.length
    if (isPinned()) {
      if (!sentinelVisibleRef.current) {
        setVisibleCount((prev) => Math.min(prev, INITIAL_VISIBLE_BLOCKS))
      }
    } else if (appended > 0) {
      setVisibleCount((prev) => prev + appended)
    }
  }, [blocks.length, isPinned])

  return (
    <Flex ref={rootRef} justify='end' className='min-h-full min-w-0 gap-3 px-4 py-4'>
      {session.loading ? (
        <div className='text-sm text-muted-foreground'>loading…</div>
      ) : session.messages.length === 0 ? (
        <div className='text-sm text-muted-foreground'>{emptyText ?? 'no messages yet'}</div>
      ) : (
        <>
          {hasOlder && (
            <div ref={sentinelRef} className='py-1 text-center text-xs text-muted-foreground'>
              · · ·
            </div>
          )}
          {visibleBlocks.map((b, i) => {
            // Original index into `blocks`, not the window — keeps React keys
            // (and thus Details' per-block collapsed state) and turnByBlock
            // lookups stable as the window grows or slides.
            const index = startIndex + i
            return b.kind === 'user' ? (
              <UserMessage
                key={index}
                text={b.text}
                editDisabled={session.waiting}
                onEdit={edit ? () => edit(turnByBlock.get(index) ?? 0, b.text) : undefined}
              />
            ) : (
              <Details
                key={index}
                items={b.items}
                botName={displayName}
                agentAvatar={agentAvatar}
                defaultCollapsed={detailsCollapsedRef.current}
                onCollapseChange={onDetailsCollapseChange}
                pending={index === blocks.length - 1 && session.waiting}
              />
            )
          })}
        </>
      )}
      {session.waiting && <ThinkingIndicator />}
      <AgentChatStatusIndicators />
    </Flex>
  )
}

type DetailItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { text: string; isError?: boolean } }

type Block = { kind: 'user'; text: string } | { kind: 'details'; items: DetailItem[] }

function buildBlocks(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = []
  let details: DetailItem[] = []
  const flush = () => {
    if (details.length === 0) {
      return
    }
    blocks.push({ kind: 'details', items: details })
    details = []
  }
  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      for (const p of m.parts) {
        if (p.type !== 'text') {
          continue
        }
        const v = stripOpencroftTags(p.text || '')
        if (!v.trim()) {
          continue
        }
        blocks.push({ kind: 'user', text: v })
      }
      continue
    }
    for (const p of m.parts) {
      if (p.type === 'text') {
        const v = stripOpencroftTags(p.text || '…')
        if (!v.trim()) {
          continue
        }
        details.push({ kind: 'assistant-text', text: v })
      } else if (p.type === 'thinking') {
        if (!p.text.trim()) {
          continue
        }
        details.push({ kind: 'thinking', text: p.text })
      } else {
        details.push({ kind: 'tool', id: p.id, name: p.name, args: p.args, result: p.result })
      }
    }
  }
  flush()
  return blocks
}

function UserMessage({ text, editDisabled, onEdit }: { text: string; editDisabled?: boolean; onEdit?: () => void }) {
  return (
    <Flex row align='start' className='group w-full gap-1'>
      <Flex expanded className='gap-1.5 rounded-md bg-muted border-1 p-2'>
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
  items,
  botName,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
  pending,
}: {
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
      <Flex className='min-w-0 w-full'>
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
    <Flex className='min-w-0 w-full relative'>
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
}

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
}: AgentChatInputProps) {
  const [text, setText] = useState('')
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

  // Extension-provided input controls (e.g. voice) get a stable context: insert
  // transcribed text into the composer, send a message, or read the live reply
  // stream — all via stable refs so the memoized command bar below doesn't churn.
  const insertText = useCallback((piece: string) => {
    const value = piece.trim()
    if (value) {
      setText((prev) => (prev ? `${prev} ${value}` : value))
    }
  }, [])
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
            onChange={(e) => setText(e.target.value)}
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

function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '')
}

function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}
