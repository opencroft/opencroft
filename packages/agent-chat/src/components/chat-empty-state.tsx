'use client'

import { MessageSquare } from 'lucide-react'

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/components/ui/empty'

export interface ChatEmptyStateProps {
  // What the placeholder says. The host's words, not this component's: the
  // host knows what kind of conversation is empty, and a sentence a component
  // guessed at is worse than a plain one the host chose.
  text: string
}

/**
 * What a conversation with nothing in it looks like, on the Empty family: the
 * mark in its tile, the host's sentence as the title. The space is doing the
 * work -- an empty conversation is mostly whitespace, and a placeholder that
 * fills it loudly is worse than the bare text it replaced -- so the mark is
 * quiet and the sentence stands as the whole of it.
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
        <EmptyMedia variant='icon'>
          <MessageSquare />
        </EmptyMedia>
        <EmptyTitle>{text}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}
