'use client'

import { Button } from '@opencroft/ui-kit/button'
import { TypingDots } from '@opencroft/ui-kit/chat/typing-dots'
import { Flex } from '@opencroft/ui-kit/layout/flex'
import { Textarea } from '@opencroft/ui-kit/textarea'
import { ChevronRight, Loader2, Maximize2, Minimize2, SendIcon, ShieldAlert, ShieldCheck, ShieldCog, Sparkles } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getAutoApprove, setAutoApprove } from '@/app/(approvals)/_server/actions'
import { CommandBarMenuItem } from '@/app/(dashboard)/_canvas/command-bar'
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context'
import { messageId, normalizeHistory, type OpenclawMessage, type RawChatMessage } from '@/app/(openclaw)/_lib/messages'
import { listCommands, loadSession, type OpenclawCommand, sendMessage } from '@/app/(openclaw)/_server/actions'
import { ChainDot, type ChainDotVariant, Chained } from '@/components/experimental/chain'
import { cn } from '@/lib/utils'

export interface AgentSession {
  sessionKey: string
  messages: OpenclawMessage[]
  loading: boolean
  sending: boolean
  waiting: boolean
  botName: string
  send: (text: string) => void
}

export function useAgentSession(sessionKey: string, transformOutgoing?: (text: string, isFirstMessage: boolean) => string): AgentSession {
  const [raw, setRaw] = useState<RawChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, startSending] = useTransition()
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    setLoading(true)
    setWaiting(false)
    let active = true
    const seen = new Set<string>()
    const isAgentRunning = (rows: RawChatMessage[]): boolean => {
      // Check if the last assistant message has toolCalls without results
      const toolCallIds = new Set<string>()
      const resultIds = new Set<string>()
      let hasAssistant = false
      for (const row of rows) {
        if (row.role === 'assistant' || row.role === 'tool') {
          hasAssistant = true
        }
        const parts = Array.isArray(row.content) ? row.content : []
        for (const p of parts) {
          if (p.type === 'toolCall' && p.id) {
            toolCallIds.add(p.id)
          }
        }
        if (row.role === 'toolResult' && row.toolCallId) {
          resultIds.add(row.toolCallId)
        }
      }
      if (!hasAssistant) {
        return false
      }
      for (const id of toolCallIds) {
        if (!resultIds.has(id)) {
          return true
        }
      }
      return false
    }
    const refresh = async (resetWaiting = true) => {
      let rows: RawChatMessage[]
      try {
        rows = await loadSession({ data: sessionKey })
      } catch (error) {
        if (active) {
          console.error('loadSession failed', error)
          setLoading(false)
        }
        return
      }
      if (!active) {
        return
      }
      seen.clear()
      for (const row of rows) {
        const id = messageId(row)
        if (id) {
          seen.add(id)
        }
      }
      setRaw(rows)
      setLoading(false)
      if (resetWaiting) {
        // Don't reset waiting if agent is still running
        setWaiting(isAgentRunning(rows))
      }
    }
    refresh()
    const es = new EventSource(`/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/stream`)
    es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data) as RawChatMessage
      const id = messageId(msg)
      if (!id || seen.has(id)) {
        return
      }
      seen.add(id)
      setRaw((prev) => [...prev, msg])
    })
    es.addEventListener('tool', (e) => {
      const payload = JSON.parse(e.data) as {
        data?: { phase?: string; toolCallId?: string; name?: string; result?: unknown }
        sessionKey?: string
      }
      if (payload.data?.phase === 'result') {
        // Tool completed — refresh full history to pick up toolResult (don't reset waiting)
        refresh(false)
      }
    })
    es.addEventListener('changed', (e) => {
      const data = JSON.parse(e.data)
      // Only reset waiting when the run ends
      refresh(data.phase === 'end')
    })
    return () => {
      active = false
      es.close()
    }
  }, [sessionKey])

  const messages = useMemo(() => normalizeHistory(raw), [raw])
  const botName = extractBotName(sessionKey)

  const isFirstMessage = messages.length === 0
  const send = useCallback(
    (value: string) => {
      const payload = transformOutgoing ? transformOutgoing(value, isFirstMessage) : value
      setWaiting(true)
      startSending(async () => {
        try {
          await sendMessage({ data: { key: sessionKey, text: payload } })
        } catch (error) {
          console.error('sendMessage failed', error)
          setWaiting(false)
        }
      })
    },
    [sessionKey, transformOutgoing, isFirstMessage],
  )

  return useMemo(() => ({ sessionKey, messages, loading, sending, waiting, botName, send }), [sessionKey, messages, loading, sending, waiting, botName, send])
}

interface AgentChatProps {
  session: AgentSession
  emptyText?: string
  agentAvatar?: string
  agentName?: string
}

const SCROLL_BOTTOM_THRESHOLD = 32

function useStickToBottom(resetKey: string) {
  const rootRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  useEffect(() => {
    const root = rootRef.current
    const viewport = root?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!root || !viewport) {
      return
    }
    const onScroll = () => {
      nearBottom.current = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_BOTTOM_THRESHOLD
    }
    viewport.addEventListener('scroll', onScroll)
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) {
        viewport.scrollTop = viewport.scrollHeight
      }
    })
    observer.observe(root)
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    const viewport = root?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) {
      return
    }
    nearBottom.current = true
    viewport.scrollTop = viewport.scrollHeight
  }, [resetKey])

  return rootRef
}

export function AgentChat({ session, emptyText, agentAvatar, agentName }: AgentChatProps) {
  const displayName = agentName ?? session.botName
  const blocks = useMemo(() => buildBlocks(session.messages), [session.messages])
  const rootRef = useStickToBottom(session.sessionKey)
  const chainCollapsedRef = useRef(true)
  const onChainCollapseChange = useCallback((collapsed: boolean) => {
    chainCollapsedRef.current = collapsed
  }, [])

  return (
    <Flex ref={rootRef} justify='end' className='min-h-full min-w-0 gap-3 px-4 py-4'>
      {session.loading ? (
        <div className='text-sm text-muted-foreground'>loading…</div>
      ) : session.messages.length === 0 ? (
        <div className='text-sm text-muted-foreground'>{emptyText ?? 'no messages yet'}</div>
      ) : (
        blocks.map((b, i) =>
          b.kind === 'user' ? (
            <UserMessage key={i} text={b.text} />
          ) : (
            <Chain key={i} items={b.items} botName={displayName} agentAvatar={agentAvatar} defaultCollapsed={chainCollapsedRef.current} onCollapseChange={onChainCollapseChange} />
          ),
        )
      )}
      {session.waiting && <ThinkingIndicator botName={displayName} />}
    </Flex>
  )
}

type ChainItem = { kind: 'assistant-text'; text: string } | { kind: 'tool'; name: string; args: unknown; result?: { text: string; isError?: boolean } }

type Block = { kind: 'user'; text: string } | { kind: 'chain'; items: ChainItem[] }

function buildBlocks(messages: OpenclawMessage[]): Block[] {
  const blocks: Block[] = []
  let chain: ChainItem[] = []
  const flush = () => {
    if (chain.length === 0) {
      return
    }
    blocks.push({ kind: 'chain', items: chain })
    chain = []
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
        chain.push({ kind: 'assistant-text', text: v })
      } else {
        chain.push({ kind: 'tool', name: p.name, args: p.args, result: p.result })
      }
    }
  }
  flush()
  return blocks
}

function UserMessage({ text }: { text: string }) {
  return (
    <Flex className='gap-1.5 rounded-md bg-muted border-1 p-2'>
      <div className='prose-chat'>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </Flex>
  )
}

function toolDotVariant(item: ChainItem): ChainDotVariant {
  if (item.kind !== 'tool' || !item.result) {
    return 'default'
  }
  return item.result.isError ? 'destructive' : 'success'
}

type ChainEntry = { kind: 'header' } | { kind: 'item'; item: ChainItem }

function withHeader(items: ChainItem[]): ChainEntry[] {
  const entries: ChainEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0]?.kind === 'tool') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

function Chain({
  items,
  botName,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
}: {
  items: ChainItem[]
  botName: string
  agentAvatar?: string
  defaultCollapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)
  const entries = withHeader(items)
  const toggle =
    items.length > 1 ? (
      <ChainToggleButton
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
    let lastTextEntry: ChainEntry | null = null
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
    let lastToolAfterText: ChainItem | null = null
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
    const marker = hasAvatar ? <img src={agentAvatar} alt='' className='size-8 rounded-full object-cover' /> : <ChainDot />

    return (
      <Flex className='min-w-0 w-full'>
        <Chained marker={marker} lineAbove={false} lineBelow={false} align={hasAvatar ? 'start' : 'center'}>
          <Flex className='min-w-0 w-full gap-1'>
            <Flex row className='items-center justify-between w-full'>
              <div className='text-xs font-medium text-foreground'>{botName}</div>
              {toggle}
            </Flex>
            {/* Text — no animation, stable */}
            {lastTextEntry && lastTextEntry.kind === 'item' && lastTextEntry.item.kind === 'assistant-text' && lastTextEntry.item.text.trim() && (
              <div className='prose-chat'>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{lastTextEntry.item.text}</ReactMarkdown>
              </div>
            )}
            {/* Tool call — animate on changes */}
            {lastToolAfterText && (
              <div key={lastToolAfterText.toolCallId}>
                <ToolBlock name={lastToolAfterText.name} args={lastToolAfterText.args} result={lastToolAfterText.result} />
              </div>
            )}
            {/* If no text entry found, show the very last entry */}
            {!lastTextEntry &&
              (() => {
                const last = entries[entries.length - 1]
                if (last?.kind === 'item') {
                  if (last.item.kind === 'tool') {
                    return <ToolBlock name={last.item.name} args={last.item.args} result={last.item.result} />
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
        const marker = hasAvatar ? <img src={agentAvatar} alt='' className='size-8 rounded-full object-cover' /> : <ChainDot variant={entry.kind === 'item' ? toolDotVariant(entry.item) : 'default'} />
        return (
          <Chained key={i} marker={marker} lineAbove={!isFirst} lineBelow={!isLast} align={hasAvatar ? 'start' : 'center'}>
            {renderEntry(entry, isFirst ? botName : undefined, isFirst ? toggle : undefined)}
          </Chained>
        )
      })}
    </Flex>
  )
}

function ChainToggleButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? Maximize2 : Minimize2
  return (
    <button
      type='button'
      onClick={onToggle}
      className={cn(
        'shrink-0 size-6 inline-flex items-center justify-center rounded-md transition-colors',
        collapsed ? 'text-muted-foreground hover:text-foreground hover:bg-accent' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      )}
      title={collapsed ? 'Show chain' : 'Collapse chain'}
    >
      <Icon className='size-3.5' />
    </button>
  )
}

function renderEntry(entry: ChainEntry, botName?: string, toggle?: React.ReactNode) {
  if (entry.kind === 'header') {
    return <AssistantText text='' botName={botName} toggle={toggle} />
  }
  const { item } = entry
  if (item.kind === 'assistant-text') {
    return <AssistantText text={item.text} botName={botName} toggle={toggle} />
  }
  return <ToolBlock name={item.name} args={item.args} result={item.result} />
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

export function ThinkingIndicator({ botName }: { botName: string }) {
  const [phrase, setPhrase] = useState(() => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)])
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

interface AgentChatInputProps {
  session: AgentSession
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  onSlashOpenChange?: (open: boolean) => void
  /** Extra content rendered at the start of the command bar (left of sparkles icon). */
  leadingBarContent?: React.ReactNode
}

export function AgentChatInput({ session, placeholder, autoFocus, onFocus, onBlur, onSlashOpenChange, leadingBarContent }: AgentChatInputProps) {
  const [text, setText] = useState('')
  const [commands, setCommands] = useState<OpenclawCommand[]>([])
  const [highlight, setHighlight] = useState(0)
  const [autoApprove, setAutoApproveState] = useState(false)
  const [yoloMode, setYoloMode] = useState(false)

  useEffect(() => {
    listCommands().then(setCommands)
    getAutoApprove().then(setAutoApproveState)
    fetch('/api/yolo')
      .then((r) => r.json())
      .then(({ enabled }) => setYoloMode(enabled))
      .catch(() => {})
  }, [])

  const toggleAutoApprove = async () => {
    const next = await setAutoApprove({ data: !autoApprove })
    setAutoApproveState(next)
  }

  const matches = useMemo(() => findMatches(text, commands), [text, commands])

  useEffect(() => {
    setHighlight(0)
  }, [matches.length])

  useEffect(() => {
    onSlashOpenChange?.(matches.length > 0)
  }, [matches.length, onSlashOpenChange])

  const inputPlaceholder = placeholder ?? `Message ${shortKey(session.sessionKey)}…`

  const pick = (command: OpenclawCommand) => {
    const alias = command.textAliases[0] ?? `/${command.name}`
    if (command.acceptsArgs) {
      setText(`${alias} `)
      return
    }
    setText('')
    session.send(alias)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || session.sending) {
      return
    }
    if (matches.length > 0) {
      const target = matches[highlight]
      const alias = target.textAliases[0] ?? `/${target.name}`
      if (value.toLowerCase() === alias.toLowerCase()) {
        setText('')
        session.send(value)
        return
      }
      pick(target)
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
      return
    }
    if (matches.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((h) => Math.min(h + 1, matches.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const cmd = matches[highlight]
      if (cmd) {
        const alias = cmd.textAliases[0] ?? `/${cmd.name}`
        setText(cmd.acceptsArgs ? `${alias} ` : alias)
      }
    }
  }

  const menuNode = useMemo(() => {
    if (matches.length === 0) {
      return null
    }
    return matches.map((m, i) => (
      <CommandBarMenuItem key={m.name} active={i === highlight} onSelect={() => pick(m)} onHover={() => setHighlight(i)}>
        <div className='flex items-center gap-2 text-sm'>
          <span className='font-mono'>{m.textAliases[0] ?? `/${m.name}`}</span>
          <span className='ml-auto text-[10px] uppercase tracking-wide text-muted-foreground'>{m.category}</span>
        </div>
        {m.description && <div className='text-xs text-muted-foreground'>{m.description}</div>}
      </CommandBarMenuItem>
    ))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, highlight])

  const barNode = useMemo(
    () => (
      <>
        {leadingBarContent}
        <Sparkles className='h-4 w-4 ml-1 mt-1.5 shrink-0 text-primary' />
        <Textarea
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
        <Button type='button' size='icon' variant='ghost' className='h-7 w-7 shrink-0 mt-0.5' onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={!text.trim() || session.sending}>
          <SendIcon className='h-4 w-4' />
        </Button>
      </>
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ),
    [leadingBarContent, text, session.sending, inputPlaceholder, autoFocus, autoApprove],
  )

  useOverlayMenu(menuNode)
  useOverlayBar(barNode)

  return null
}

function findMatches(text: string, commands: OpenclawCommand[]): OpenclawCommand[] {
  const trimmed = text.trim().toLowerCase()
  if (!trimmed.startsWith('/')) {
    return []
  }
  return commands.filter((c) => c.textAliases.some((a) => a.toLowerCase().startsWith(trimmed))).slice(0, 10)
}

function ToolBlock({ name, args, result }: { name: string; args: unknown; result?: { text: string; isError?: boolean } }) {
  const isError = result?.isError === true
  const [open, setOpen] = useState(false)
  return (
    <Flex className='gap-1.5'>
      <button type='button' onClick={() => setOpen((v) => !v)} className='flex items-center gap-2 text-xs text-left cursor-pointer'>
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className='font-mono font-medium shrink-0'>{name}</span>
        {previewArg(name, args) && <span className='font-mono text-muted-foreground'>{previewArg(name, args)}</span>}
        {!result && !open && <Loader2 className='size-3 shrink-0 animate-spin text-muted-foreground' />}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {open && (
        <div className={cn('rounded-md border bg-muted/30 text-xs overflow-hidden', isError && 'border-destructive/60')}>
          <ToolRow label='args'>
            <pre className='max-h-48 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{JSON.stringify(args, null, 2)}</pre>
          </ToolRow>
          {result ? (
            <>
              <div className='border-t' />
              <ToolRow label='output'>
                <pre className='overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{result.text}</pre>
              </ToolRow>
            </>
          ) : (
            <>
              <div className='border-t' />
              <ToolRow label='output'>
                <Flex row align='center' className='gap-1.5 text-muted-foreground'>
                  <Loader2 className='size-3 animate-spin' />
                  <span>running…</span>
                </Flex>
              </ToolRow>
            </>
          )}
        </div>
      )}
    </Flex>
  )
}

function ToolRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex row className='gap-3 px-3 py-2'>
      <div className='w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>{label}</div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  )
}

const PREVIEW_ARG: Record<string, string> = {
  edit: 'path',
  read: 'path',
  write: 'path',
  list: 'path',
  glob: 'pattern',
  grep: 'pattern',
  search: 'pattern',
  exec: 'command',
  bash: 'command',
  run: 'command',
  fetch: 'url',
  url: 'url',
  web_fetch: 'url',
}

function previewArg(name: string, args: unknown): string | null {
  const key = PREVIEW_ARG[name.toLowerCase()]
  if (!key || !args || typeof args !== 'object') {
    return null
  }
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string' || !value) {
    return null
  }
  return value
}

function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '')
}

function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}

function extractBotName(key: string): string {
  return key.split(':')[1] ?? 'assistant'
}
