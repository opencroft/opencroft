'use client'

import { MessagesSquare, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from 'ui/button'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { DockPanel, type DockSide } from 'ui/layouts/dock-panel'
import { cn } from 'ui/lib/utils'

import { EmbeddedAgentChat } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

/**
 * The thread slug every space surface addresses. One per member agent, chosen
 * in the chat's own picker -- so the full reference is
 * `{space-slug}.{agent}.main`.
 *
 * A constant rather than a prop: a space has ONE chat surface, and letting a
 * caller pick the thread would let two surfaces in the same space address
 * different threads and look like the same conversation.
 */
const SPACE_THREAD_ID = 'main'

// ONE ARRANGEMENT FOR THE PERSON, NOT ONE PER SPACE. Where the chat sits, how
// wide it is and whether it is open follow the reader from space to space, so
// opening a different space shows the chat where this browser left it.
//
// These were keyed per space until 30.08.2026 -- `opencroft.space.<slug>.chat*`
// -- and per-space was itself asked for the day before that. The reversal is the
// deliberate choice, so anyone who finds an older instruction saying "per space"
// is reading the superseded one and should not key these back to a slug.
//
// The old keys are simply no longer read. There is deliberately no fallback to
// them, no migration, and no routine that goes looking for them to tidy up:
// code written to service the old shape is the legacy this was meant to drop,
// and whatever those keys still hold is inert.
//
// Per browser rather than per account, because this is local storage -- the
// arrangement does not follow the reader to another machine. That is inherent to
// where it is stored, not a decision taken here.
const CHAT_DOCK_KEY = 'opencroft.spaceChat.dock'
const CHAT_OPEN_KEY = 'opencroft.spaceChat.open'
const CHAT_SIZE_KEY = 'opencroft.spaceChat.size'

const CHAT_DOCK_DEFAULT: DockSide = 'right'
const CHAT_OPEN_DEFAULT = false

/** Which edge a closed chat's rail sits on -- the one it will open from. */
const RAIL_BORDER: Record<DockSide, string> = {
  left: 'border-r',
  right: 'border-l',
  bottom: 'border-t',
}

interface Props {
  /** The space's slug. Also the group chat's address -- the two are the same
   *  string by decision, which is what lets a space find its chat again. */
  slug: string
  /** The space's display name, used only if the chat has to be created. */
  spaceName: string
  /** The surface the chat is docked beside: the space's canvas. */
  children: ReactNode
}

/**
 * A space's chat, and how it sits beside the space.
 *
 * It renders the SAME component an extension gets from the host API, not a
 * second implementation of a chat -- so the composer, the transcript, the
 * agent picker and the selection badge are one thing with one set of
 * behaviours, and a fix to any of them reaches both surfaces at once. The same
 * argument decides the chrome around it: the docking switch and the drag
 * handle are the kit's DockPanel, which is what the extension dashboards will
 * draw once they are converted onto it.
 *
 * It sits inside the canvas's selection scope on purpose: that is what lets
 * selecting a node on the canvas ride along with the next message.
 *
 * THREE ARRANGEMENTS, ONE CHAT. Docked beside the canvas on a wide screen; a
 * rail on the same edge when it is closed; and below the mobile breakpoint it
 * covers the canvas instead, with no docking and no resizing, because a side
 * panel there is a fight for width neither side can win -- the canvas becomes
 * unusable and the chat is still too narrow to read.
 *
 * The covering container is a plain positioned element rather than the kit's
 * Sheet, deliberately: it is not a modal at all. No overlay, no focus trap, no
 * portal, no dismissal semantics -- a Sheet would be four things configured
 * away to arrive back at a div. What it costs is stated where it is chosen:
 * the canvas stays in the tab order behind the cover, and Escape does not
 * close it.
 *
 * Where the panel sits, how wide it is and whether it is open are remembered
 * ONCE FOR THE BROWSER rather than per space, so the chat is where the reader
 * left it whichever space they open. They stay local to the browser, so an
 * arrangement chosen here is not imposed on a colleague.
 */
export function SpaceChatDock({ slug, spaceName, children }: Props) {
  const [open, setOpen] = useLocalStorage<boolean>(CHAT_OPEN_KEY, CHAT_OPEN_DEFAULT)
  const [dock, setDock] = useLocalStorage<DockSide>(CHAT_DOCK_KEY, CHAT_DOCK_DEFAULT)
  // Undefined until one has been set, which is what tells the panel to keep its
  // own default rather than being resized to a remembered nothing.
  const [size, setSize] = useLocalStorage<number | undefined>(CHAT_SIZE_KEY, undefined)
  const isMobile = useIsMobile()

  // `min-h-0` here and on every column above it: without it the chat's own
  // scroller resolves its height against its content rather than the column,
  // and the composer rides up under the last message instead of staying at the
  // bottom -- the same trap the group-chat screen hit.
  const chat = <EmbeddedAgentChat space={slug} id={SPACE_THREAD_ID} title={spaceName} className='min-h-0 flex-1' />

  const surface = <div className='flex min-h-0 min-w-0 flex-1'>{children}</div>

  const openChat = (
    <Button variant='ghost' size='icon' aria-label='Open chat' title='Open chat' onClick={() => setOpen(true)}>
      <MessagesSquare className='size-4' />
    </Button>
  )

  if (isMobile) {
    return (
      // `relative` so the chat can COVER the canvas rather than take width from
      // it.
      <div className='relative flex h-full min-h-0 w-full'>
        {surface}
        {open ? (
          <div className='absolute inset-0 z-30 flex min-h-0 flex-col bg-background'>
            <div className='flex items-center justify-between gap-2 border-b px-2 py-1'>
              <span className='truncate text-xs font-medium text-foreground'>{spaceName}</span>
              <Button
                variant='ghost'
                size='icon'
                aria-label='Close chat'
                title='Close chat'
                onClick={() => setOpen(false)}
              >
                <X className='size-4' />
              </Button>
            </div>
            {chat}
          </div>
        ) : (
          // Floating rather than a strip down the edge: a closed panel must cost
          // no width at all here, and the canvas is the whole screen.
          <Button
            size='icon'
            aria-label='Open chat'
            title='Open chat'
            className='absolute right-3 bottom-3 z-30 rounded-full shadow-md'
            onClick={() => setOpen(true)}
          >
            <MessagesSquare className='size-4' />
          </Button>
        )}
      </div>
    )
  }

  if (!open) {
    const rail = <div className={cn('flex shrink-0 bg-background p-1', RAIL_BORDER[dock])}>{openChat}</div>
    return (
      <div className={cn('flex h-full min-h-0 w-full', dock === 'bottom' && 'flex-col')}>
        {dock === 'left' ? rail : null}
        {surface}
        {dock === 'left' ? null : rail}
      </div>
    )
  }

  return (
    <DockPanel
      dock={dock}
      onDockChange={setDock}
      size={size}
      onSizeChange={setSize}
      title={spaceName}
      // A cross rather than a closing-panel glyph: the panel closes to three
      // different edges, and a glyph that points at one of them is wrong on the
      // other two.
      actions={
        <Button
          variant='ghost'
          size='icon-xs'
          aria-label='Close chat'
          title='Close chat'
          onClick={() => setOpen(false)}
        >
          <X />
        </Button>
      }
      panel={chat}
      className='h-full w-full'
    >
      {surface}
    </DockPanel>
  )
}
