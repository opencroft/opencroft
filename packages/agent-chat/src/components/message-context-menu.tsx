'use client'

import { Copy, Reply } from 'lucide-react'
import { createContext, type PointerEvent, type ReactNode, useContext, useRef } from 'react'
import { toast } from 'sonner'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from 'ui/components/ui/context-menu'
import { cn } from 'ui/lib/utils'

import { selectedTextWithin } from './message-selection'

// What a message's menu can do besides copying, supplied by whatever renders
// the transcript beside a composer. Without a provider the menu offers Copy
// alone, which is right for a transcript with nowhere to reply into.
export interface MessageActions {
  // Reply with a message's text -- the selected part of it, or all of it. The
  // text arrives unquoted; how it is put into the composer is the provider's.
  onReply?: (text: string) => void
}

const MessageActionsContext = createContext<MessageActions>({})

export const MessageActionsProvider = MessageActionsContext.Provider

// How long a selection read at the press stays the one the menu uses. The
// menu opens on the same gesture -- at once for a right-click, after the
// primitive's 500 ms hold for a touch -- so anything older belongs to a press
// that never opened it, and the menu reads the selection as it is instead.
const PRESS_SNAPSHOT_MS = 1500

export interface MessageContextMenuProps {
  // The message's own markdown source: what the menu acts on when nothing
  // inside the message is selected.
  text: string
  className?: string
  children: ReactNode
}

// A message's context menu: right-click on a pointer, a long press on touch.
// Copy puts the text on the clipboard; Reply hands it to the provider.
//
// THE TEXT IS WHAT THE READER SELECTED INSIDE THIS MESSAGE, else the whole of
// it. A selection that runs on into other messages is cut to this one.
//
// READ AT THE PRESS, NOT AT THE OPEN. The gesture that opens the menu can
// change the selection before the menu sees it: a right-click on macOS selects
// the word under the pointer, and a long press on a phone starts a native
// selection of its own. Either would turn "copy this message" into "copy one
// word". So the selection is read when the press begins, and read at open only
// when no press preceded it (the keyboard's menu key).
//
// The message stays selectable. The kit's trigger is `select-none`, which suits
// the rows it was written for and would make a message impossible to select at
// all -- the one thing this menu is built around.
export function MessageContextMenu({ text, className, children }: MessageContextMenuProps) {
  const { onReply } = useContext(MessageActionsContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef<{ text: string; at: number } | null>(null)
  // What the open menu acts on when something is selected; '' means the whole
  // message, read from `text` at the moment an item is chosen so a reply still
  // streaming in is taken as it stands then.
  const selectedRef = useRef('')

  const readSelection = () =>
    rootRef.current ? selectedTextWithin(rootRef.current, document.getSelection()) : ''

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 2 || event.pointerType === 'touch') {
      pressRef.current = { text: readSelection(), at: performance.now() }
    }
  }

  const onOpenChange = (open: boolean) => {
    if (!open) {
      return
    }
    const press = pressRef.current
    pressRef.current = null
    selectedRef.current = press && performance.now() - press.at < PRESS_SNAPSHOT_MS ? press.text : readSelection()
  }

  const target = () => selectedRef.current || text

  const copy = () => {
    navigator.clipboard.writeText(target()).then(
      () => toast.success('Copied', { duration: 1500 }),
      () => toast.error('Could not copy to the clipboard'),
    )
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger ref={rootRef} className={cn('min-w-0 select-text', className)} onPointerDown={onPointerDown}>
        {children}
      </ContextMenuTrigger>
      {/* No focus restored on close: Reply moves focus into the composer, and
          handing it back to the message would take it straight out again. */}
      <ContextMenuContent finalFocus={false}>
        <ContextMenuItem onClick={copy}>
          <Copy className='size-3.5' />
          Copy
        </ContextMenuItem>
        {onReply ? (
          <ContextMenuItem onClick={() => onReply(target())}>
            <Reply className='size-3.5' />
            Reply
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
