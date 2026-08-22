'use client'

import { MessageSquare } from 'lucide-react'

export interface ChatEmptyStateProps {
  // What the placeholder says. The host's words, not this component's: the
  // host knows what kind of conversation is empty, and a sentence a component
  // guessed at is worse than a plain one the host chose.
  text: string
}

/**
 * What a conversation with nothing in it looks like: one quiet mark, one
 * sentence, centred. The space is doing the work -- an empty conversation is
 * mostly whitespace, and a placeholder that fills it loudly is worse than the
 * bare text it replaced -- so the mark is small, the sentence is muted, and
 * nothing here competes with the first message once it arrives.
 *
 * Presentation only, and deliberately not the whole empty state: centring the
 * placeholder in the scroll region is the layout the conversation component
 * performs (it owns the region), so this is the visual and nothing else. A
 * host reusing it elsewhere places it the same way -- inside whatever box it
 * wants it centred in.
 */
export function ChatEmptyState({ text }: ChatEmptyStateProps) {
  return (
    <div className='flex flex-col items-center gap-3 text-center'>
      <div className='flex size-10 items-center justify-center rounded-full border bg-muted'>
        <MessageSquare className='size-4 text-muted-foreground' />
      </div>
      <p className='max-w-xs text-sm text-muted-foreground'>{text}</p>
    </div>
  )
}
