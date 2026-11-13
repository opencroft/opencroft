'use client'

import { Reply } from 'lucide-react'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { SelectionBar, useSelectionBar } from 'ui/components/ui/selection-bar'
import { cn } from 'cn'

import { selectedTextWithin } from './message-selection'

/*
 * What a conversation's messages offer besides their text. A message's text
 * is the browser's to select, copy and look up: right-click and the phone's
 * own selection menu are left alone. Text selected inside a message gets the
 * selection bar, with Reply; a whole message's actions are in its `⋮` menu.
 */

// What a message can do besides being read, supplied by whatever renders the
// transcript beside a composer. Without a provider there is nothing to offer:
// no selection bar, and no Reply in a message's menu.
export interface MessageActions {
  // Reply with a message's text -- the selected part of it, or all of it. The
  // text arrives unquoted; how it is put into the composer is the provider's.
  onReply?: (text: string) => void
}

const MessageActionsContext = createContext<MessageActions>({})

export const MessageActionsProvider = MessageActionsContext.Provider

export function useMessageActions(): MessageActions {
  return useContext(MessageActionsContext)
}

/** Marks a message's text, which the selection bar acts on. */
const MESSAGE_ATTRIBUTE = 'data-selectable-message'

export interface SelectableMessageProps {
  className?: string
  children: ReactNode
}

/**
 * A message's text, as the selection bar finds it. It stays selectable: the
 * surfaces it sits in (a sticky header, a row with controls) may not be.
 */
export function SelectableMessage({ className, children }: SelectableMessageProps) {
  return (
    <div {...{ [MESSAGE_ATTRIBUTE]: '' }} className={cn('min-w-0 select-text', className)}>
      {children}
    </div>
  )
}

function messageAt(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest(`[${MESSAGE_ATTRIBUTE}]`) ?? null
}

interface MessageSelection {
  /** Changes whenever the selection's ends move. */
  key: string
  /** The message the selection starts in, which Reply acts on. */
  message: Element
}

/**
 * The reader's selection, while it starts inside a message and holds more than
 * whitespace. Read without touching the selection: reading the message's part
 * of it re-selects for a moment, which would be a selection change of its own.
 */
function useMessageSelection(): MessageSelection | null {
  const [current, setCurrent] = useState<MessageSelection | null>(null)
  useEffect(() => {
    let count = 0
    let last: Range | null = null
    const onChange = () => {
      const selection = document.getSelection()
      const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null
      const message = range && selection?.toString().trim() ? messageAt(range.startContainer) : null
      if (!range || !message) {
        last = null
        setCurrent(null)
        return
      }
      const moved =
        !last ||
        last.startContainer !== range.startContainer ||
        last.startOffset !== range.startOffset ||
        last.endContainer !== range.endContainer ||
        last.endOffset !== range.endOffset
      if (moved) {
        count += 1
        last = range.cloneRange()
      }
      const key = String(count)
      setCurrent((previous) => (previous?.key === key && previous.message === message ? previous : { key, message }))
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
      setCurrent(null)
    }
  }, [])
  return current
}

/** The box around the selection, as the bar is placed against. */
function selectionAnchor(message: Element) {
  return {
    contextElement: message,
    getBoundingClientRect: () => {
      const selection = document.getSelection()
      return selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).getBoundingClientRect()
        : message.getBoundingClientRect()
    },
  }
}

export interface MessageSelectionBarProps {
  /** The conversation whose messages the bar serves. */
  children: ReactNode
}

/**
 * The selection bar for a conversation's messages: Reply, for text selected
 * inside a message, quoting the selected part of that one message. It wraps
 * the whole conversation, inside its `MessageActionsProvider`, as the
 * editor's field wraps its text, and adds no box of its own to the layout.
 * Without a Reply from the provider there is no bar.
 *
 * Escape closes it until the selection changes. Replying clears the selection,
 * so the bar and the platform's selection menu go with it.
 */
export function MessageSelectionBar({ children }: MessageSelectionBarProps) {
  const { onReply } = useMessageActions()
  // Nothing to offer, so nothing to watch: no listeners on the selection.
  return onReply ? <ReplyBar onReply={onReply}>{children}</ReplyBar> : children
}

function ReplyBar({ onReply, children }: { onReply: (text: string) => void; children: ReactNode }) {
  const current = useMessageSelection()
  // A mouse press in the conversation starts a selection, which the bar waits
  // out; a press on the bar, portalled outside it, does not.
  const [pressTarget, setPressTarget] = useState<HTMLElement | null>(null)
  const bar = useSelectionBar({ selection: current?.key ?? null, pressTarget })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const open = bar.open && current !== null && current.key !== dismissed
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDismissed(current?.key ?? null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, current])
  const anchor = useMemo(() => (current ? selectionAnchor(current.message) : undefined), [current])

  const reply = () => {
    const selection = document.getSelection()
    const text = current ? selectedTextWithin(current.message, selection) : ''
    if (text) {
      onReply(text)
    }
    selection?.removeAllRanges()
  }
  return (
    <>
      <div ref={setPressTarget} className='contents'>
        {children}
      </div>
      <SelectionBar
        open={open}
        anchor={anchor}
        touch={bar.touch}
        actions={[{ id: 'reply', label: 'Reply', icon: Reply, showLabel: true, onSelect: reply }]}
      />
    </>
  )
}
