'use client'

import { MessagesSquare, PanelRightClose } from 'lucide-react'
import { Button } from 'ui/button'
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
 * A space's chat, docked beside its canvas.
 *
 * It renders the SAME component an extension gets from the host API, not a
 * second implementation of a chat -- so the composer, the transcript, the
 * agent picker and the selection badge are one thing with one set of
 * behaviours, and a fix to any of them reaches both surfaces at once.
 *
 * It sits inside the canvas's selection scope on purpose: that is what lets
 * selecting a node on the canvas ride along with the next message.
 */
export function SpaceChatPanel({ slug, spaceName }: Props) {
  // Per space, so opening the chat in one does not open it in every space.
  const [open, setOpen] = useLocalStorage<boolean>(`opencroft.space.${slug}.chatOpen`, false)

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
    <aside className={cn('flex w-96 shrink-0 flex-col border-l bg-background min-h-0')}>
      <div className='flex items-center justify-between gap-2 border-b px-2 py-1'>
        <span className='truncate text-xs font-medium text-foreground'>{spaceName}</span>
        <Button variant='ghost' size='icon' aria-label='Close chat' title='Close chat' onClick={() => setOpen(false)}>
          <PanelRightClose className='size-4' />
        </Button>
      </div>
      {/* `min-h-0` on both this and the aside: without it the chat's own
          scroller resolves its height against its content rather than the
          column, and the composer rides up under the last message instead of
          staying at the bottom -- the same trap the group-chat screen hit. */}
      <EmbeddedAgentChat space={slug} id={SPACE_THREAD_ID} title={spaceName} className='min-h-0 flex-1' />
    </aside>
  )
}
