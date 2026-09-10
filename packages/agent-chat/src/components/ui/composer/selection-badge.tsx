'use client'

import { Eye, EyeOff, X } from 'lucide-react'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'

// RELATIVE ON PURPOSE, and not `@/components/ui/composer/agent-command-bar`. The command
// bar is a sibling in this same design project, and an aliased path to a
// sibling gets rewritten on install -- through the `ui` alias, which means
// `packages/ui`, where a chat-generic component does not live. The installed
// file then imports its way straight out of the package it was just installed
// into, and the failure is invisible here: the preview resolves by name, so it
// renders either way. A relative path has no alias to be rewritten through.
//
// The rule, and the line between these two imports: a SIBLING in this project
// is imported relatively; a shadcn primitive that really does live in the
// shared package keeps the alias, which is why `button` below is unchanged.
// Please do not normalise this back to the alias form.
import { commandBarControlHeight } from './agent-command-bar'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

// The chip stands at the action row's height, and its two controls sit one
// step down inside it, inset by the chip's own padding. 24px is the smallest
// box WCAG 2.2 still counts as a target -- and it is where these two land once
// they are nested rather than standing in the row themselves. The X was 16px
// before any of this, which was under it.
const INSET_CONTROL = 'h-6'
const INSET_CONTROL_SQUARE = 'size-6 shrink-0'

// Without-ref on purpose: `forwardRef` below already contributes the ref to
// the public props, and carrying it in both places is how the two definitions
// get to disagree.
export interface SelectionBadgeProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  // What the reader sees. Presentation only: what the message actually carries
  // is the host's business and deliberately not this component's -- a label
  // reads like "3 commits" or a heading, while what travels may be pages.
  label: string
  // Whether the selection goes with the next message. Positive form on
  // purpose -- the control states what will happen, not what will not.
  //
  // Optional, and going by default: a chip drawn on a message that has already
  // been sent is a record that the selection went with it, and a readout has no
  // toggle to disagree with.
  included?: boolean
  // A press on the label: hold the selection back, or send it again. The
  // selection itself survives either way; only this flag moves.
  //
  // OMIT IT and the label is a readout rather than a toggle -- see the note on
  // the component below for why absence decides that rather than a flag.
  onToggleIncluded?: () => void
  // The X: drop the selection entirely. Distinct from holding it back, which
  // is why the two are separate controls rather than one three-state press.
  //
  // OMIT IT and no X is drawn, for the same reason.
  onClear?: () => void
}

// What the reader has selected somewhere else on the screen, shown in the
// composer so it is visible that the next message will carry it.
//
// ONE CHIP, TWO CONTROLS INSIDE IT. The chip is the bordered surface: it holds
// the state, it stands at the row's height, and both controls live within it --
// the eye and the label on the left, the X at the right. The chip itself is not
// a button, which is what keeps the X from being a button inside a button. The
// two inner controls are, so each has its own press, its own hover and the
// kit's own focus-visible treatment rather than this control's private copy of
// one.
//
// TWO CONTROLS, NOT ONE. Holding a selection back and discarding it are
// different intentions -- the first is about this message, the second about the
// selection -- and a single control cycling through both would make the
// destructive one reachable by a press meant for the reversible one.
//
// THE STATE IS TOLD THREE WAYS, NONE OF THEM COLOUR. The chip is FILLED when
// the selection is going and empty when it is held; the glyph is an eye or a
// crossed-out eye; the label is struck through while held. Each is a difference
// in shape, and any one of them survives a reader who cannot use the colour.
// `aria-pressed` carries the same fact to anything listening.
//
// THE EYE IS INSIDE THE TOGGLE, not beside it. It states what the toggle is
// about, so a press that lands on the glyph does the thing the glyph describes
// -- a state icon sitting outside the control it describes is a target that
// looks live and is not.
//
// HEIGHT COMES FROM THE ROW, NOT FROM HERE. The chip reads the agent command
// bar's exported `commandBarControlHeight` rather than a number typed into this
// file: a number copied into a slot child drifts from the row it copied, which
// is exactly how this came to be a 24px control in a 28px row.
//
// WHAT GIVES IS THE LABEL, and it was chosen rather than inherited. Everything
// else in that cluster is a fixed-size affordance or a readout: shrinking an
// icon button costs hittability, and shrinking the context ring costs the
// number it exists to show. A label loses nothing but characters, and it
// already truncates. So the chip carries `min-w-0` and no `shrink-0` -- which
// is what marks it, to the flex row it sits in, as the one that yields.
//
// EITHER CONTROL APPEARS ONLY WHERE THE HOST GAVE IT SOMETHING TO DO, and that
// is what lets this same chip stand on a message that has already gone. There
// it is a record rather than a control: the selection travelled, so there is
// nothing left to hold back and nothing to discard. The handler being absent is
// what decides it, rather than a read-only flag -- a flag would also admit the
// state that means nothing, read-only with handlers wired, and a component
// cannot offer an action it was given no way to perform. A disabled button
// would be the wrong shape for the same reason: it says "this could be pressed,
// but not now", which was never true here.
//
// Presentational throughout: it holds no selection, stores no flag and phrases
// nothing about what the agent receives.
export const SelectionBadge = forwardRef<HTMLSpanElement, SelectionBadgeProps>(function SelectionBadge(
  { label, included = true, onToggleIncluded, onClear, className, ...rest },
  ref,
) {
  // The chip's contents, written once and used by both forms so the truncation
  // and the three state signals cannot drift between the control and the
  // readout.
  //
  // min-w-0 as well as truncate: whatever box holds this is a flex container,
  // and a flex item refuses to shrink below its longest unbreakable word until
  // it is told it may. Without it a long path widens the chip instead of being
  // cut.
  const glyphAndLabel = (
    <>
      {included ? <Eye className='size-3.5 shrink-0' /> : <EyeOff className='size-3.5 shrink-0' />}
      <span className={cn('min-w-0 truncate', included ? '' : 'line-through')}>{label}</span>
    </>
  )

  return (
    <span
      ref={ref}
      // Spread first, this component's own presentation after. A composer slot
      // is exactly the sort of place something gets wrapped in a tooltip or a
      // menu trigger later, and an `asChild` parent renders no element of its
      // own -- it clones this one and injects its handlers and its ref onto it.
      // A component that destructured a fixed prop list and spread nothing
      // would drop them on the floor: no error, no warning, a trigger wired to
      // nothing. This declares no handler of its own at this level, so there is
      // nothing here to compose with rather than replace.
      {...rest}
      className={cn(
        commandBarControlHeight,
        'inline-flex min-w-0 max-w-48 items-center gap-0.5 rounded-md border px-1',
        // Fill, not hue: the chip is a filled surface while the selection is
        // going and an empty one while it is held.
        included ? 'bg-secondary' : 'bg-background',
        className,
      )}
    >
      {onToggleIncluded ? (
        <Button
          type='button'
          variant='ghost'
          onClick={onToggleIncluded}
          // The composer keeps focus when this is pressed -- losing it
          // mid-sentence to a control beside the box is its own small betrayal.
          onMouseDown={(event) => event.preventDefault()}
          aria-pressed={included}
          title={
            included
              ? `"${label}" is sent with the next message — press to hold it back`
              : `"${label}" is held back — press to send it with the next message`
          }
          className={cn(INSET_CONTROL, 'min-w-0 gap-1 px-1 text-xs', included ? '' : 'text-muted-foreground')}
        >
          {glyphAndLabel}
        </Button>
      ) : (
        <span
          className={cn(
            INSET_CONTROL,
            'inline-flex min-w-0 items-center gap-1 px-1 text-xs',
            included ? '' : 'text-muted-foreground',
          )}
        >
          {glyphAndLabel}
        </span>
      )}
      {onClear ? (
        <Button
          type='button'
          variant='ghost'
          size='icon'
          onClick={onClear}
          onMouseDown={(event) => event.preventDefault()}
          title='Clear selection'
          aria-label='Clear selection'
          className={INSET_CONTROL_SQUARE}
        >
          <X className='size-3.5' />
        </Button>
      ) : null}
    </span>
  )
})
