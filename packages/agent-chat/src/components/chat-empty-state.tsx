'use client'

import { MessageCircleDashed } from 'lucide-react'

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/components/ui/empty'

export interface ChatEmptyStateProps {
  // What the placeholder says. The host's words, not this component's: the
  // host knows what kind of conversation is empty, and a sentence a component
  // guessed at is worse than a plain one the host chose.
  text: string
}

/**
 * What a conversation with nothing in it looks like, on the Empty family: a
 * bare quiet mark, the host's sentence under it. The space is doing the work
 * -- an empty conversation is mostly whitespace, and a placeholder that fills
 * it loudly is worse than the bare text it replaced -- so no tile behind the
 * icon and no heading type on the sentence: both sit in the muted foreground,
 * at body size.
 *
 * Presentation only, and deliberately not the whole empty state: centring the
 * placeholder in the panel is the layout the host performs around the
 * conversation, so this is the visual and nothing else. A host reusing it
 * elsewhere places it the same way -- inside whatever box it wants it
 * centred in.
 */
export function ChatEmptyState({ text }: ChatEmptyStateProps) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <MessageCircleDashed className='size-5 text-muted-foreground' />
        </EmptyMedia>
        <EmptyTitle className='text-sm font-normal text-muted-foreground'>{text}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}
