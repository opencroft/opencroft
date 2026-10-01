'use client'

import { type ChatMessage, isTerminalToolStatus } from 'agent-client/fold'
import { cn } from 'cn'
import { Maximize2, Minimize2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'

import { ChainDot, type ChainDotVariant, Chained } from './components/chain'
import { type MessageHandlers, MessageView } from './messages'
import type { ToolViewRegistry } from './tool-views'

export interface TurnDetailsProps extends MessageHandlers {
  // One non-user turn's messages (a `ChatBlock` of kind 'chain').
  items: ChatMessage[]
  toolViews: ToolViewRegistry
  hideToolCalls?: boolean
  // Shown beside the first item, and again as the collapsed view's label.
  botName?: string
  agentAvatar?: string
  // Seeds this turn's initial collapsed state — typically the last turn's
  // choice, so toggling one turn sets the default for turns that arrive after
  // it (see `collapsedDefaultRef` in chat-view.tsx).
  defaultCollapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  // True while this is the active (last, still-generating) turn.
  pending?: boolean
}

type Entry = { kind: 'header' } | { kind: 'item'; item: ChatMessage }

// A turn with no leading assistant text (e.g. it opens straight into a tool
// call) gets a synthetic header entry, so the bot name/avatar and collapse
// toggle still have somewhere to render.
function withHeader(items: ChatMessage[]): Entry[] {
  const entries: Entry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0] && items[0].kind !== 'assistant') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

function dotVariant(message: ChatMessage): ChainDotVariant {
  if (message.kind === 'tool') {
    const settled = isTerminalToolStatus(message.status)
    if (!settled && message.output === undefined) return 'default'
    return message.status === 'failed' ? 'destructive' : 'success'
  }
  if (message.kind === 'error' || (message.kind === 'notice' && message.severity === 'error')) return 'destructive'
  return 'default'
}

function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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

function TurnHeader({ botName, toggle }: { botName?: string; toggle?: ReactNode }) {
  if (!botName && !toggle) return null
  return (
    <Flex row className='items-center justify-between w-full'>
      {botName ? <div className='text-xs font-medium text-foreground'>{botName}</div> : null}
      {toggle}
    </Flex>
  )
}

// One non-user turn, rendered as a vertical chain: a status dot per item
// (default/success/destructive, an avatar on the first), connected by a rail.
// More than one item earns a collapse toggle that condenses the turn down to
// its last text plus the tool call and the notices that followed it — useful
// once a turn has accumulated several tool calls a reader doesn't need to
// re-scan.
export function TurnDetails({
  items,
  toolViews,
  hideToolCalls,
  botName,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
  pending,
  onRespondPermission,
  onRespondAsk,
  onRespondText,
}: TurnDetailsProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)
  const entries = withHeader(items)
  const toggle =
    items.length > 1 ? (
      <CollapseToggle
        collapsed={collapsed}
        onToggle={() => {
          const next = !collapsed
          setCollapsed(next)
          onCollapseChange?.(next)
        }}
      />
    ) : null

  if (collapsed) {
    // The last assistant text and what followed it (see `afterText`) — a
    // compact "where things ended up" summary for the turn.
    let lastTextIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.kind === 'item' && entry.item.kind === 'assistant' && entry.item.text.trim()) {
        lastTextIndex = i
        break
      }
    }
    const lastText = lastTextIndex >= 0 ? (entries[lastTextIndex] as Extract<Entry, { kind: 'item' }>).item : null
    let lastToolAfterText: ChatMessage | null = null
    if (lastTextIndex >= 0) {
      for (let i = entries.length - 1; i > lastTextIndex; i--) {
        const entry = entries[i]
        if (entry.kind === 'item' && entry.item.kind === 'tool') {
          lastToolAfterText = entry.item
          break
        }
      }
    }
    const lastEntry = entries[entries.length - 1]
    // What follows the last text, in order: the tool call it ended on and
    // every notice. A notice after the reply is usually the turn's outcome (a
    // hook that blocked it), so folding it away would read as a normal reply.
    // With no text at all, the turn's last entry stands in for the reply.
    const afterText = entries
      .slice(lastTextIndex + 1)
      .filter((entry): entry is Extract<Entry, { kind: 'item' }> => entry.kind === 'item')
      .map((entry) => entry.item)
      .filter(
        (item) =>
          item.kind === 'notice' ||
          item === lastToolAfterText ||
          (!lastText && lastEntry?.kind === 'item' && item === lastEntry.item),
      )
    // A permission/ask item never counts as "shown" by the summary above
    // (it's neither the last text nor a tool call) — surface any unresolved
    // one regardless, or it silently vanishes into a collapsed turn with no
    // cue that the session is waiting on the user.
    const shown = new Set([lastText?.id, ...afterText.map((item) => item.id)])
    const unresolvedRequests = entries.filter(
      (entry): entry is Extract<Entry, { kind: 'item' }> =>
        entry.kind === 'item' &&
        (entry.item.kind === 'permission' || entry.item.kind === 'ask') &&
        !entry.item.resolved &&
        !shown.has(entry.item.id),
    )
    const marker = agentAvatar ? <AgentAvatar avatar={agentAvatar} name={botName} size='md' /> : <ChainDot />
    return (
      <Flex className='min-w-0 w-full'>
        <Chained marker={marker} lineAbove={false} lineBelow={false} align={agentAvatar ? 'start' : 'first-line'}>
          <Flex className='min-w-0 w-full gap-1'>
            <TurnHeader botName={botName} toggle={toggle} />
            {lastText ? (
              <MessageView
                message={lastText}
                toolViews={toolViews}
                hideToolCalls={hideToolCalls}
                onRespondPermission={onRespondPermission}
                onRespondAsk={onRespondAsk}
                onRespondText={onRespondText}
              />
            ) : null}
            {afterText.map((item) => (
              <MessageView
                key={item.id}
                message={item}
                toolViews={toolViews}
                hideToolCalls={hideToolCalls}
                onRespondPermission={onRespondPermission}
                onRespondAsk={onRespondAsk}
                onRespondText={onRespondText}
              />
            ))}
            {unresolvedRequests.map((entry) => (
              <MessageView
                key={entry.item.id}
                message={entry.item}
                toolViews={toolViews}
                hideToolCalls={hideToolCalls}
                onRespondPermission={onRespondPermission}
                onRespondAsk={onRespondAsk}
                onRespondText={onRespondText}
              />
            ))}
          </Flex>
        </Chained>
      </Flex>
    )
  }

  return (
    <Flex className='min-w-0 w-full relative'>
      {entries.map((entry, index) => {
        const isFirst = index === 0
        const isLast = index === entries.length - 1
        const hasAvatar = isFirst && !!agentAvatar
        const marker = hasAvatar ? (
          <AgentAvatar avatar={agentAvatar} name={botName} size='md' />
        ) : (
          <ChainDot variant={entry.kind === 'item' ? dotVariant(entry.item) : 'default'} />
        )
        return (
          <Chained
            key={entry.kind === 'header' ? 'header' : entry.item.id}
            marker={marker}
            lineAbove={!isFirst}
            lineBelow={!isLast}
            align={hasAvatar ? 'start' : 'first-line'}
          >
            <Flex className='min-w-0 w-full gap-1'>
              {isFirst ? <TurnHeader botName={botName} toggle={toggle} /> : null}
              {entry.kind === 'item' ? (
                <MessageView
                  message={entry.item}
                  toolViews={toolViews}
                  hideToolCalls={hideToolCalls}
                  pending={isLast && pending}
                  onRespondPermission={onRespondPermission}
                  onRespondAsk={onRespondAsk}
                  onRespondText={onRespondText}
                />
              ) : null}
            </Flex>
          </Chained>
        )
      })}
    </Flex>
  )
}
