'use client'

import { MessagesSquare, PanelRightClose, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from 'ui/button'
import { useIsMobile } from 'ui/hooks/use-mobile'
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

interface Props {
  /** The space's slug. Also the group chat's address -- the two are the same
   *  string by decision, which is what lets a space find its chat again. */
  slug: string
  /** The space's display name, used only if the chat has to be created. */
  spaceName: string
}

/**
 * A space's chat.
 *
 * It renders the SAME component an extension gets from the host API, not a
 * second implementation of a chat -- so the composer, the transcript, the
 * agent picker and the selection badge are one thing with one set of
 * behaviours, and a fix to any of them reaches both surfaces at once.
 *
 * It sits inside the canvas's selection scope on purpose: that is what lets
 * selecting a node on the canvas ride along with the next message.
 *
 * TWO CONTAINERS, ONE CHAT. On a wide screen it docks beside the canvas. Below
 * the mobile breakpoint it covers the canvas instead, because a side panel
 * there is a fight for width neither side can win -- the canvas becomes
 * unusable and the chat is still too narrow to read. Only the container
 * differs: the same component, the same open state, the same toggle.
 *
 * The covering container is a plain positioned element rather than the kit's
 * Sheet, deliberately. Sheet is dialog-backed, and the chat opens a dialog of
 * its own when it has to create the group -- nesting one inside the other is
 * where focus traps fight, and this container needs to do nothing a div cannot.
 */
export function SpaceChatPanel({ slug, spaceName }: Props) {
  // Per space, so opening the chat in one does not open it in every space.
  const [open, setOpen] = useLocalStorage<boolean>(`opencroft.space.${slug}.chatOpen`, false)
  const isMobile = useIsMobile()

  const chat = (
    // `min-h-0` here and on every column above it: without it the chat's own
    // scroller resolves its height against its content rather than the column,
    // and the composer rides up under the last message instead of staying at
    // the bottom -- the same trap the group-chat screen hit.
    <EmbeddedAgentChat space={slug} id={SPACE_THREAD_ID} title={spaceName} className='min-h-0 flex-1' />
  )

  const header = (label: string, icon: ReactNode) => (
    <div className='flex items-center justify-between gap-2 border-b px-2 py-1'>
      <span className='truncate text-xs font-medium text-foreground'>{spaceName}</span>
      <Button variant='ghost' size='icon' aria-label={label} title={label} onClick={() => setOpen(false)}>
        {icon}
      </Button>
    </div>
  )

  if (isMobile) {
    if (!open) {
      // Floating rather than a strip down the edge: a closed panel must cost no
      // width at all here, and the canvas is the whole screen.
      return (
        <Button
          size='icon'
          aria-label='Open chat'
          title='Open chat'
          className='absolute right-3 bottom-3 z-30 rounded-full shadow-md'
          onClick={() => setOpen(true)}
        >
          <MessagesSquare className='size-4' />
        </Button>
      )
    }
    return (
      <div className='absolute inset-0 z-30 flex min-h-0 flex-col bg-background'>
        {header('Close chat', <X className='size-4' />)}
        {chat}
      </div>
    )
  }

  if (!open) {
    return (
      <div className='flex shrink-0 flex-col border-l bg-background p-1'>
        <Button variant='ghost' size='icon' aria-label='Open chat' title='Open chat' onClick={() => setOpen(true)}>
          <MessagesSquare className='size-4' />
        </Button>
      </div>
    )
  }

  return (
    <aside className={cn('flex w-96 min-h-0 shrink-0 flex-col border-l bg-background')}>
      {header('Close chat', <PanelRightClose className='size-4' />)}
      {chat}
    </aside>
  )
}
