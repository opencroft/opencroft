import { cn } from 'cn'

// Literal lookup rather than a composed class name: a class built from a prop
// is a string no scanner ever sees, so the variant renders inert. Same rule as
// the rest of the kit.
const SIZES = {
  xs: 'text-xs',
  sm: 'text-sm',
} as const

export interface ListEmptyProps {
  // The sentence, from the host. It is not this component's to write: only the
  // host knows whether the list is empty because nothing exists yet or because
  // nothing matched, and those are different sentences. Six lists were each
  // saying their own before this existed -- what varied was never the words,
  // it was the padding, the type size and whether it was centred at all.
  text: string
  // A sidebar list and a detail pane genuinely read at different sizes, so
  // both are offered rather than one being imposed. Two values, not six
  // spellings.
  size?: keyof typeof SIZES
  className?: string
}

// The line a list shows when it has nothing to show.
//
// **Deliberately not the Empty family.** shadcn's `Empty` -- a mark in a tile
// above a title, which is what chat-empty-state is built on -- is a page-scale
// placeholder. Putting it inside a sidebar list would spend more vertical
// space on the absence than the list spends on its contents. The two are
// different components on purpose: this one for a list, that one for a pane.
export function ListEmpty({ text, size = 'sm', className }: ListEmptyProps) {
  return <p className={cn('px-2 py-6 text-center text-muted-foreground', SIZES[size], className)}>{text}</p>
}
