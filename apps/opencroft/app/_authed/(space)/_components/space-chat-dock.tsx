'use client'

import { MessagesSquare, X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { Button } from 'ui/button'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { DockPanel, type DockSide } from 'ui/layouts/dock-panel'
import { cn } from 'ui/lib/utils'

import { EmbeddedAgentChat } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import {
  CHAT_DOCK_DEFAULT,
  CHAT_DOCK_KEY,
  CHAT_OPEN_DEFAULT,
  CHAT_OPEN_KEY,
  CHAT_SIZE_KEY,
  dropPerSpaceChatPreferences,
} from '@/app/_authed/(space)/_components/space-chat-preferences'
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

  // The per-space keys these three replaced are dropped, never read. Unguarded
  // by any "already done" marker because the walk is self-clearing: once the old
  // keys are gone it matches nothing, and a marker would be one more key living
  // forever to save enumerating a store that holds a few dozen entries.
  useEffect(() => {
    dropPerSpaceChatPreferences(window.localStorage)
  }, [])

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
