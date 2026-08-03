'use client'

import { Maximize2, Minimize2, Pencil } from 'lucide-react'
import type { ComponentProps, ComponentType, ReactNode } from 'react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Button } from '@/components/ui/button'
import { Flex } from '@/components/ui/layout/flex'
import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { cn } from '@/lib/utils'

// The attribute the host's scroll restore uses to find a block again and
// measure how far it moved. Exported so the host queries the same name rather
// than duplicating the literal.
export const BLOCK_ID_ATTR = 'data-block-id'

// A user's own words, after the host has passed them through its own
// sanitiser. Branded rather than `string` on purpose: this is the only
// component that renders a user's message, and requiring the brand is what
// closes the route raw stream text once took into the sticky header. A host
// cannot hand this component text that has not been through that step.
export type UserText = string & { readonly __userText: unique symbol }

// Declared here rather than imported from the package that also defines it: a
// type-only import still puts that package in this one's import graph and
// manifest, which is the layering this component exists on the right side of.
// The host's own copies satisfy this structurally.
export type ChainDotVariant = 'default' | 'success' | 'destructive'

// One item inside a turn's detail chain. The host builds these; this component
// only renders them.
//
// Only a tool call carries an `id`: it is the React key for the single node the
// collapsed view re-renders, and it is the request id a tool view resolves
// against. Text and thinking entries are keyed by position instead, so giving
// them an id would be inventing data the host does not have.
export type DetailItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { text: string; isError?: boolean } }

export type DetailEntry = { kind: 'header' } | { kind: 'item'; item: DetailItem }

// The pieces this component renders but deliberately does not own.
//
// **This bundle is a seam, not a preference.** The chain rail and the thinking
// block each exist in more than one implementation in this workspace, and which
// one renders has to stay the host's choice until they are consolidated --
// otherwise one conversation mixes two copies of the same component. Taking
// them as props keeps that decision where it can be made once, for the whole
// conversation.
//
// Markdown is deliberately NOT in here: rendering its own content is this
// component's job, and a renderer slot would push a rendering concern onto
// every consumer.
//
// When the consolidation lands these collapse into plain imports and this type
// goes away. A consumer reading these as props can see they are a seam; the
// same code written as imports would just look like a settled decision.
export interface ChatTurnRenderers {
  // One segment of the vertical rail: a marker beside the segment's content.
  Chained: ComponentType<{
    marker: ReactNode
    lineAbove: boolean
    lineBelow: boolean
    align?: 'center' | 'start'
    children: ReactNode
  }>
  // The small status dot used as a rail marker.
  ChainDot: ComponentType<{ variant?: ChainDotVariant }>
  // A collapsible reasoning block.
  ThinkingBlock: ComponentType<{ text: string; pending?: boolean }>
}

// Every markdown link in chat content opens in a new tab, so following one
// never costs the conversation the reader was in. `noopener` is required
// alongside `target="_blank"` -- without it the opened page keeps a handle on
// ours through `window.opener`.
//
// This is behaviour, not formatting, and it is why the markdown renderer is not
// a host prop: as a slot, every consumer would have to re-establish it, and a
// consumer that passed a bare renderer would silently lose it. Owning the
// renderer here is what makes the guarantee a property of the component.
function MarkdownLink({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  return <a {...props} target='_blank' rel='noopener noreferrer' />
}

const markdownLinkComponents: Components = { a: MarkdownLink }

// Chat content is markdown, and rendering it is this component's own
// presentation rather than something a host supplies: a message component that
// cannot render its own message is not a component, and pushing the renderer
// out as a slot would make every consumer re-wire a rendering concern.
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
      {text}
    </ReactMarkdown>
  )
}

export function ChatLoadOlderButton({ loading, onLoadOlder }: { loading: boolean; onLoadOlder: () => void }) {
  return (
    <Flex row justify='center' className='w-full py-1'>
      <Button variant='ghost' size='sm' disabled={loading} onClick={onLoadOlder}>
        {loading ? 'loading…' : 'load older messages'}
      </Button>
    </Flex>
  )
}

export interface ChatUserMessageProps {
  // Marks this block in the DOM so the host's load-older restore can find it
  // again and measure how far it moved. Sits on the outermost box, which is the
  // block's own element in the flow.
  blockId: string
  text: UserText
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
  //    later in the document -- so anything lower loses to it on tree order and
  //    the replies paint over the header.
  //  - It must not exceed the composer, which is also `z-1` and later in the
  //    document still. Equal values are broken by tree order, so the composer
  //    keeps painting over the header, which is what a raised value broke.
  // No integer sits between those, which is why matching the composer rather
  // than clearing it is the fix.
  sticky?: boolean
  renderers: ChatTurnRenderers
}

export function ChatUserMessage({ blockId, text, editDisabled, onEdit, sticky, renderers }: ChatUserMessageProps) {
  const { Chained } = renderers
  return (
    // The same rail the replies below are rendered in, so both columns start at
    // the same left edge by construction rather than by a matched indent -- if
    // the rail's width changes, the two move together. The avatar has no source
    // yet and falls back to a person icon, which is the intended placeholder.
    //
    // The rail's own `py-2` is what spaces the message from the viewport edge
    // once stuck, so the `pt-2 -mt-2` pair this used to carry is gone rather
    // than added to: keeping both would have doubled the gap. Unstuck, that
    // padding is the same rhythm every reply already has.
    <div
      // `container-type: scroll-state` makes this queryable as a stuck element.
      // It applies no containment -- unlike the size container types, which add
      // style and size containment plus an independent formatting context -- so
      // it cannot disturb the header's box (CSS Conditional 5).
      className={cn(sticky && 'sticky top-0 z-1 [container-type:scroll-state]')}
      {...{ [BLOCK_ID_ATTR]: blockId }}
    >
      {sticky && (
        // The header's backing: fully opaque at its top edge, falling away to
        // nothing at its bottom, so replies dissolve as they pass under it
        // instead of being clipped at a line.
        //
        // Spanning the element is what lets the falloff be this long. A layer
        // hanging BELOW the box -- the first approach -- could never exceed the
        // gap to the next reply without tinting it in normal flow, which capped
        // it at 12px. This one is entirely inside the box, so it cannot reach
        // the reply at all and the cap doesn't apply.
        //
        // The fade runs the whole height rather than starting halfway down, so
        // the gradient spans its own element the way the chat's bottom fade
        // does. One construction, both ends.
        //
        // It costs no legibility even though it fades behind the message: the
        // question sits in its own `bg-muted` bubble and the avatar in a
        // `bg-muted` circle, both opaque in either theme, so nothing passes
        // behind the text. What this layer backs is the gutter around them --
        // the rail, and the strip beside the edit control -- and a reply showing
        // through there as it passes is the accepted trade, not a defect. If it
        // ever reads badly the answer is a different stop position, never a
        // second opaque layer.
        <div
          aria-hidden
          className='absolute inset-0 -z-1 pointer-events-none bg-linear-to-b from-background to-transparent'
        />
      )}

      <Chained marker={<AgentAvatar size='md' />} lineAbove={false} lineBelow={false} align='start'>
        <Flex row align='start' className='group w-full gap-1'>
          <Flex expanded className='relative gap-1.5 rounded-md bg-muted border-1 p-2'>
            {sticky && (
              // The stuck message's shadow -- the command bar's, on the same
              // opaque rounded box the composer's card uses, so it floats on
              // the gradient rather than tracing a dissolving edge.
              //
              // Its own layer, matching the bubble's box by being its child,
              // because only opacity may animate: this appears and disappears
              // repeatedly as each header pushes the previous one out during a
              // single scroll, and a transitioned box-shadow would repaint
              // every time. Behind the bubble's background, which hides
              // nothing -- an outer shadow is drawn outside the border box.
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
            {/* Three lines, but only while this header is stuck to the top.
                That is the whole of the problem: a question renders at its full
                height, and because the header holds the top of the viewport
                while its own replies scroll underneath, a tall one covers the
                answer it belongs to. Read in its own place in the flow it costs
                nothing, so it is left alone there.

                Clamping only where it matters is what removes the need for any
                expand control: the message is already whole wherever the reader
                is actually looking at it, and short again the moment it becomes
                a header. Nothing to press, nothing to measure, no state.

                A container query on the wrapper's own scroll-state, so it costs
                no scroll listener and animates nothing -- the backing still
                spans the wrapper's box, the shadow still matches the bubble by
                being its child, and the rail still aligns the columns.

                Where scroll-state queries are unsupported the query never
                matches and a stuck header is not clamped at all. Those are the
                same browsers that already render no stuck shadow. */}
            <div className='prose-chat [@container_scroll-state(stuck:top)]:line-clamp-3'>
              <Markdown text={text} />
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

export function ChatDetailsToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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

export function ChatAssistantText({
  text,
  botName,
  toggle,
}: {
  text: string
  botName?: string
  toggle?: ReactNode
}) {
  return (
    <Flex className='min-w-0 w-full gap-1'>
      <Flex row className='items-center justify-between w-full'>
        {botName ? <div className='text-xs font-medium text-foreground'>{botName}</div> : null}
        {toggle}
      </Flex>
      {text ? (
        <div className='prose-chat'>
          <Markdown text={text} />
        </div>
      ) : null}
    </Flex>
  )
}

function toolDotVariant(item: DetailItem): ChainDotVariant {
  if (item.kind !== 'tool' || !item.result) {
    return 'default'
  }
  return item.result.isError ? 'destructive' : 'success'
}

function withHeader(items: DetailItem[]): DetailEntry[] {
  const entries: DetailEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0] && items[0].kind !== 'assistant-text') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

export interface ChatTurnDetailsProps {
  blockId: string
  items: DetailItem[]
  botName: string
  agentAvatar?: string
  defaultCollapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  // True while this turn is the active turn and still generating.
  pending?: boolean
  // Renders one tool call. A registered view gives e.g. a file edit a real diff
  // instead of a raw args dump; which views exist is the host's registry, not
  // this component's business.
  renderTool: (item: Extract<DetailItem, { kind: 'tool' }>) => ReactNode
  renderers: ChatTurnRenderers
}

// The assistant's side of a turn: a chain of text, thinking and tool calls,
// collapsible to just its last text plus the tool call that followed it.
export function ChatTurnDetails({
  blockId,
  items,
  botName,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
  pending,
  renderTool,
  renderers,
}: ChatTurnDetailsProps) {
  const { Chained, ChainDot, ThinkingBlock } = renderers
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)
  const entries = withHeader(items)
  const toggle =
    items.length > 1 ? (
      <ChatDetailsToggle
        collapsed={collapsed}
        onToggle={() => {
          const next = !collapsed
          setCollapsed(next)
          onCollapseChange?.(next)
        }}
      />
    ) : null

  const renderEntry = (entry: DetailEntry, name?: string, entryToggle?: ReactNode, entryPending?: boolean) => {
    if (entry.kind === 'header') {
      return <ChatAssistantText text='' botName={name} toggle={entryToggle} />
    }
    const { item } = entry
    if (item.kind === 'assistant-text') {
      return <ChatAssistantText text={item.text} botName={name} toggle={entryToggle} />
    }
    if (item.kind === 'thinking') {
      return <ThinkingBlock text={item.text} pending={entryPending} />
    }
    return renderTool(item)
  }

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
                  <Markdown text={lastTextEntry.item.text} />
                </div>
              )}
            {/* Tool call — animate on changes */}
            {lastToolAfterText && lastToolAfterText.kind === 'tool' && (
              <div key={lastToolAfterText.id}>{renderTool(lastToolAfterText)}</div>
            )}
            {/* If no text entry found, show the very last entry */}
            {!lastTextEntry &&
              (() => {
                const last = entries[entries.length - 1]
                if (last?.kind === 'item') {
                  if (last.item.kind === 'tool') {
                    return renderTool(last.item)
                  }
                  if (last.item.kind === 'assistant-text') {
                    return last.item.text.trim() ? (
                      <div className='prose-chat'>
                        <Markdown text={last.item.text} />
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
